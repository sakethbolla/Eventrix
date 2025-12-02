const express = require('express');
const axios = require('axios');
const Booking = require('../models/Booking');
const { verifyToken } = require('../middleware/auth');
const { sendBookingEmail, sendWaitlistEmail } = require('../utils/email');

const router = express.Router();

const EVENT_SERVICE_URL = process.env.EVENT_SERVICE_URL || 'http://localhost:4002';

const generateTransactionId = () => `TXN${Date.now()}${Math.floor(Math.random() * 10000)}`;

const promoteWaitlistIfPossible = async (eventId, availableSeatsHint) => {
  try {
    const eventResponse = await axios.get(`${EVENT_SERVICE_URL}/api/events/${eventId}`);
    const event = eventResponse.data;
    let availableSeats = typeof availableSeatsHint === 'number' ? availableSeatsHint : event.availableSeats;

    if (availableSeats <= 0) {
      return;
    }

    const waitlistedBookings = await Booking.find({
      eventId,
      bookingStatus: 'waitlisted'
    }).sort({ createdAt: 1 });

    for (const waitlisted of waitlistedBookings) {
      if (availableSeats < waitlisted.numberOfTickets) {
        break;
      }

      waitlisted.bookingStatus = 'confirmed';
      waitlisted.paymentStatus = 'completed';
      waitlisted.transactionId = generateTransactionId();
      await waitlisted.save();

      availableSeats -= waitlisted.numberOfTickets;

      await axios.patch(`${EVENT_SERVICE_URL}/api/events/${eventId}/seats`, {
        seatsToBook: waitlisted.numberOfTickets
      });

      await sendBookingEmail(waitlisted, event);
    }
  } catch (err) {
    console.error('Waitlist promotion failed:', err.message);
  }
};

// POST /api/bookings - Create a new booking or waitlist entry
router.post('/', verifyToken, async (req, res) => {
  try {
    const { eventId, numberOfTickets, paymentMethod, joinWaitlist } = req.body;

    if (!eventId || !numberOfTickets) {
      return res.status(400).json({ error: 'Event ID and number of tickets are required' });
    }

    let eventResponse;
    try {
      eventResponse = await axios.get(`${EVENT_SERVICE_URL}/api/events/${eventId}`);
    } catch (err) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const event = eventResponse.data;

    if (event.status === 'cancelled') {
      return res.status(400).json({ error: 'Event has been cancelled' });
    }

    if (new Date(event.date) < new Date()) {
      return res.status(400).json({ error: 'Cannot book tickets for past events' });
    }

    const shouldWaitlist = event.availableSeats < numberOfTickets;

    if (shouldWaitlist && !joinWaitlist) {
      return res.status(400).json({
        error: 'Not enough seats available',
        availableSeats: event.availableSeats,
        requested: numberOfTickets
      });
    }

    const booking = new Booking({
      userId: req.user._id,
      userName: req.user.name,
      userEmail: req.user.email,
      eventId: event._id,
      eventTitle: event.title,
      eventDate: event.date,
      eventVenue: event.venue,
      eventTime: event.time,
      numberOfTickets,
      pricePerTicket: event.price,
      paymentMethod: paymentMethod || 'credit_card'
    });

    if (shouldWaitlist) {
      booking.bookingStatus = 'waitlisted';
      booking.paymentStatus = 'pending';
      await booking.save();

      await sendWaitlistEmail(booking, event);

      return res.status(202).json({
        message: 'Event is full. You have been added to the waitlist.',
        booking: {
          bookingReference: booking.bookingReference,
          bookingStatus: booking.bookingStatus,
          eventTitle: booking.eventTitle,
          eventDate: booking.eventDate,
          eventVenue: booking.eventVenue,
          numberOfTickets: booking.numberOfTickets
        }
      });
    }

    const paymentSuccess = Math.random() > 0.1;

    if (!paymentSuccess) {
      booking.paymentStatus = 'failed';
      booking.bookingStatus = 'pending';
      await booking.save();

      return res.status(400).json({
        error: 'Payment failed. Please try again.',
        bookingReference: booking.bookingReference
      });
    }

    booking.paymentStatus = 'completed';
    booking.bookingStatus = 'confirmed';
    booking.transactionId = generateTransactionId();

    try {
      await axios.patch(`${EVENT_SERVICE_URL}/api/events/${eventId}/seats`, {
        seatsToBook: numberOfTickets
      });
    } catch (err) {
      return res.status(500).json({
        error: 'Failed to update event seats',
        details: err.response?.data || err.message
      });
    }

    await booking.save();
    await sendBookingEmail(booking, event);

    res.status(201).json({
      message: 'Booking confirmed successfully',
      booking: {
        bookingReference: booking.bookingReference,
        eventTitle: booking.eventTitle,
        eventDate: booking.eventDate,
        eventVenue: booking.eventVenue,
        numberOfTickets: booking.numberOfTickets,
        totalAmount: booking.totalAmount,
        paymentStatus: booking.paymentStatus,
        transactionId: booking.transactionId,
        bookingStatus: booking.bookingStatus
      }
    });
  } catch (err) {
    console.error('Booking creation error:', err);
    res.status(500).json({ error: 'Failed to create booking', details: err.message });
  }
});

// GET /api/bookings - Get all bookings for logged-in user
router.get('/', verifyToken, async (req, res) => {
  try {
    const bookings = await Booking.find({ userId: req.user._id }).sort({ createdAt: -1 });

    res.json({
      count: bookings.length,
      bookings
    });
  } catch (err) {
    console.error('Get bookings error:', err);
    res.status(500).json({ error: 'Failed to fetch bookings', details: err.message });
  }
});

// GET /api/bookings/event/:eventId/me - Check if the user has a booking for an event
router.get('/event/:eventId/me', verifyToken, async (req, res) => {
  try {
    const booking = await Booking.findOne({ 
      eventId: req.params.eventId, 
      userId: req.user._id,
      bookingStatus: { $ne: 'cancelled' }
    });

    if (!booking) {
      return res.json({ hasBooking: false });
    }

    res.json({
      hasBooking: true,
      bookingStatus: booking.bookingStatus,
      bookingReference: booking.bookingReference
    });
  } catch (err) {
    console.error('Check event booking error:', err);
    res.status(500).json({ error: 'Failed to verify booking', details: err.message });
  }
});

// GET /api/bookings/analytics - Aggregate stats for admins
router.get('/analytics', verifyToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Admin only.' });
  }

  try {
    const bookings = await Booking.find();

    const stats = {
      totalBookings: bookings.length,
      confirmedBookings: bookings.filter(b => b.bookingStatus === 'confirmed').length,
      cancelledBookings: bookings.filter(b => b.bookingStatus === 'cancelled').length,
      waitlistedBookings: bookings.filter(b => b.bookingStatus === 'waitlisted').length,
      totalRevenue: bookings
        .filter(b => b.paymentStatus === 'completed')
        .reduce((sum, b) => sum + b.totalAmount, 0),
      totalTicketsSold: bookings
        .filter(b => b.bookingStatus === 'confirmed')
        .reduce((sum, b) => sum + b.numberOfTickets, 0)
    };

    const waitlistByEvent = await Booking.aggregate([
      { $match: { bookingStatus: 'waitlisted' } },
      { $group: { _id: '$eventId', count: { $sum: 1 } } }
    ]);

    const waitlistWithEvents = await Promise.all(waitlistByEvent.map(async entry => {
      try {
        const eventResponse = await axios.get(`${EVENT_SERVICE_URL}/api/events/${entry._id}`);
        return { ...entry, title: eventResponse.data.title };
      } catch (err) {
        return { ...entry, title: 'Unknown event' };
      }
    }));

    res.json({ stats, waitlistByEvent: waitlistWithEvents });
  } catch (err) {
    console.error('Get analytics error:', err);
    res.status(500).json({ error: 'Failed to fetch booking analytics', details: err.message });
  }
});

// GET /api/bookings/:id - Get single booking
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.userId !== req.user._id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(booking);
  } catch (err) {
    console.error('Get booking error:', err);
    res.status(500).json({ error: 'Failed to fetch booking', details: err.message });
  }
});

// GET /api/bookings/reference/:reference - Get booking by reference number
router.get('/reference/:reference', verifyToken, async (req, res) => {
  try {
    const booking = await Booking.findOne({ bookingReference: req.params.reference });

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.userId !== req.user._id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(booking);
  } catch (err) {
    console.error('Get booking by reference error:', err);
    res.status(500).json({ error: 'Failed to fetch booking', details: err.message });
  }
});

// PATCH /api/bookings/:id/cancel - Cancel a booking
router.patch('/:id/cancel', verifyToken, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.userId !== req.user._id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (booking.bookingStatus === 'cancelled') {
      return res.status(400).json({ error: 'Booking is already cancelled' });
    }

    if (new Date(booking.eventDate) < new Date()) {
      return res.status(400).json({ error: 'Cannot cancel booking for past events' });
    }

    const wasConfirmed = booking.bookingStatus === 'confirmed';
    booking.bookingStatus = 'cancelled';
    if (booking.paymentStatus === 'completed') {
      booking.paymentStatus = 'refunded';
    }
    await booking.save();

    let restoredAvailability;
    if (wasConfirmed) {
      try {
        const seatResponse = await axios.patch(`${EVENT_SERVICE_URL}/api/events/${booking.eventId}/seats`, {
          seatsToBook: -booking.numberOfTickets
        });
        restoredAvailability = seatResponse.data?.availableSeats;
      } catch (err) {
        console.error('Failed to restore event seats:', err.message);
      }
    }

    if (restoredAvailability !== undefined) {
      await promoteWaitlistIfPossible(booking.eventId, restoredAvailability);
    }

    res.json({
      message: 'Booking cancelled successfully',
      booking: {
        bookingReference: booking.bookingReference,
        bookingStatus: booking.bookingStatus,
        paymentStatus: booking.paymentStatus,
        refundAmount: booking.totalAmount
      }
    });
  } catch (err) {
    console.error('Cancel booking error:', err);
    res.status(500).json({ error: 'Failed to cancel booking', details: err.message });
  }
});

// GET /api/bookings/event/:eventId - Get all bookings for an event (admin only)
router.get('/event/:eventId', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Admin only.' });
    }

    const bookings = await Booking.find({ eventId: req.params.eventId }).sort({ createdAt: -1 });

    const stats = {
      totalBookings: bookings.length,
      confirmedBookings: bookings.filter(b => b.bookingStatus === 'confirmed').length,
      cancelledBookings: bookings.filter(b => b.bookingStatus === 'cancelled').length,
      totalRevenue: bookings
        .filter(b => b.paymentStatus === 'completed')
        .reduce((sum, b) => sum + b.totalAmount, 0),
      totalTicketsSold: bookings
        .filter(b => b.bookingStatus === 'confirmed')
        .reduce((sum, b) => sum + b.numberOfTickets, 0)
    };

    res.json({
      stats,
      bookings
    });
  } catch (err) {
    console.error('Get event bookings error:', err);
    res.status(500).json({ error: 'Failed to fetch bookings', details: err.message });
  }
});

// PATCH /api/bookings/event/:eventId/cancel-all - Cancel all bookings for an event (internal use)
router.patch('/event/:eventId/cancel-all', async (req, res) => {
  try {
    const { eventId } = req.params;

    // Find all bookings for this event that are not already cancelled
    const bookings = await Booking.find({
      eventId,
      bookingStatus: { $ne: 'cancelled' }
    });

    // Update all bookings to cancelled status
    await Booking.updateMany(
      { eventId, bookingStatus: { $ne: 'cancelled' } },
      { 
        $set: { 
          bookingStatus: 'cancelled',
          paymentStatus: 'refunded'
        } 
      }
    );

    res.json({
      message: 'All bookings cancelled successfully',
      count: bookings.length
    });
  } catch (err) {
    console.error('Cancel all bookings error:', err);
    res.status(500).json({ error: 'Failed to cancel bookings', details: err.message });
  }
});

// PATCH /api/bookings/event/:eventId/sync - Sync event details to bookings
router.patch('/event/:eventId/sync', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { eventTitle, eventDate, eventVenue, eventTime } = req.body;

    // Update all bookings for this event with new event details
    const result = await Booking.updateMany(
      { eventId },
      { 
        $set: { 
          eventTitle,
          eventDate,
          eventVenue,
          eventTime,
          updatedAt: Date.now()
        } 
      }
    );

    res.json({
      message: 'Bookings synced successfully',
      modifiedCount: result.modifiedCount
    });
  } catch (err) {
    console.error('Sync bookings error:', err);
    res.status(500).json({ error: 'Failed to sync bookings', details: err.message });
  }
});

module.exports = router;
