const request = require('supertest');
const express = require('express');

// --- Mocks ---

jest.mock('axios', () => ({
  get: jest.fn(),
  patch: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
  verifyToken: (req, res, next) => {
    const userId = req.headers['x-test-user-id'] || 'user1';
    const role = req.headers['x-test-role'] || 'user';
    req.user = {
      _id: userId,
      name: 'Test User',
      role,
    };
    next();
  },
  isAdmin: (req, res, next) => {
    if (req.user && req.user.role === 'admin') return next();
    return res.status(403).json({ error: 'Access denied. Admin only.' });
  },
}));

jest.mock('../../models/Event', () => {
  const mockFns = {
    find: jest.fn(),
    countDocuments: jest.fn(),
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findByIdAndDelete: jest.fn(),
    aggregate: jest.fn(),
  };

  function Event(data) {
    Object.assign(this, data);
  }

  Event.prototype.save = jest.fn().mockResolvedValue(undefined);

  Object.assign(Event, mockFns);

  Event.__reset = () => {
    Object.values(mockFns).forEach(fn => fn.mockReset());
    Event.prototype.save.mockReset();
    Event.prototype.save.mockResolvedValue(undefined);
  };

  return Event;
});

jest.mock('../../models/Feedback', () => {
  const mockFns = {
    find: jest.fn(),
    aggregate: jest.fn(),
    findById: jest.fn(),
    findByIdAndDelete: jest.fn(),
    create: jest.fn(),
  };

  function Feedback(data) {
    Object.assign(this, data);
  }

  Feedback.prototype.save = jest.fn().mockResolvedValue(undefined);

  Object.assign(Feedback, mockFns);

  Feedback.__reset = () => {
    Object.values(mockFns).forEach(fn => fn.mockReset());
    Feedback.prototype.save.mockReset();
    Feedback.prototype.save.mockResolvedValue(undefined);
  };

  return Feedback;
});

// --- Imports after mocks ---

const axios = require('axios');
const eventsRouter = require('../events');
const Event = require('../../models/Event');
const Feedback = require('../../models/Feedback');

// --- Helpers ---

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/events', eventsRouter);
  return app;
};

const buildEventFindChain = (events) => {
  return {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(events),
  };
};

const buildFeedbackFindChain = (feedbackItems) => {
  return {
    sort: jest.fn().mockResolvedValue(feedbackItems),
  };
};

// Use a valid 24-char ObjectId string for feedback routes
const VALID_EVENT_ID = '507f1f77bcf86cd799439011';

// --- Test Suite ---

describe('Event routes', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    Event.__reset();
    Feedback.__reset();
    axios.get.mockReset();
    axios.patch.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------- GET /api/events ----------

  test('GET /api/events returns filtered, sorted, paginated events', async () => {
    const events = [
      {
        _id: 'evt1',
        title: 'AI Workshop',
        category: 'workshop',
        status: 'upcoming',
        date: new Date().toISOString(),
      },
    ];

    Event.find.mockReturnValue(buildEventFindChain(events));
    Event.countDocuments.mockResolvedValue(events.length);

    const res = await request(app)
      .get('/api/events')
      .query({
        category: 'workshop',
        status: 'upcoming',
        search: 'AI',
        sort: 'price-asc',
        page: 1,
        limit: 10,
      });

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(Event.find).toHaveBeenCalledTimes(1);
  });

  test('GET /api/events returns 500 on DB error', async () => {
    Event.find.mockImplementation(() => {
      throw new Error('DB error');
    });

    const res = await request(app).get('/api/events');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch events');
  });

  // ---------- GET /api/events/:id ----------

  test('GET /api/events/:id returns event', async () => {
    const event = { _id: 'evt1', title: 'Test Event' };
    Event.findById.mockResolvedValue(event);

    const res = await request(app).get('/api/events/evt1');

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Test Event');
  });

  test('GET /api/events/:id returns 404 when not found', async () => {
    Event.findById.mockResolvedValue(null);

    const res = await request(app).get('/api/events/missing');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Event not found');
  });

  test('GET /api/events/:id returns 500 on error', async () => {
    Event.findById.mockRejectedValue(new Error('DB fail'));

    const res = await request(app).get('/api/events/evt1');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch event');
  });

  // ---------- POST /api/events (admin only) ----------

  test('POST /api/events creates event for admin', async () => {
    const body = {
      title: 'New Event',
      description: 'Desc',
      category: 'workshop',
      venue: 'Hall',
      date: new Date(Date.now() + 86400000).toISOString(),
      time: '18:00',
      capacity: 100,
      price: 10,
      organizer: 'Org',
    };

    const res = await request(app)
      .post('/api/events')
      .set('x-test-role', 'admin')
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Event created successfully');
    expect(Event.prototype.save).toHaveBeenCalledTimes(1);
  });

  test('POST /api/events returns 403 for non-admin', async () => {
    const res = await request(app)
      .post('/api/events')
      .send({ title: 'Nope' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access denied. Admin only.');
  });

  test('POST /api/events returns 500 on error', async () => {
    Event.prototype.save.mockRejectedValue(new Error('DB error'));

    const body = {
      title: 'New Event',
      description: 'Desc',
      category: 'workshop',
      venue: 'Hall',
      date: new Date(Date.now() + 86400000).toISOString(),
      time: '18:00',
      capacity: 100,
      price: 10,
      organizer: 'Org',
    };

    const res = await request(app)
      .post('/api/events')
      .set('x-test-role', 'admin')
      .send(body);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to create event');
  });

  // ---------- PUT /api/events/:id (admin only) ----------

  test('PUT /api/events/:id updates event and syncs bookings', async () => {
    const updated = { _id: 'evt1', title: 'Updated', venue: 'New Hall', date: new Date(), time: '19:00' };
    Event.findByIdAndUpdate.mockResolvedValue(updated);
    axios.patch.mockResolvedValue({});

    const res = await request(app)
      .put('/api/events/evt1')
      .set('x-test-role', 'admin')
      .send({ title: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Event updated successfully');
    expect(Event.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    expect(axios.patch).toHaveBeenCalledTimes(1);
  });

  test('PUT /api/events/:id returns 404 when event missing', async () => {
    Event.findByIdAndUpdate.mockResolvedValue(null);

    const res = await request(app)
      .put('/api/events/missing')
      .set('x-test-role', 'admin')
      .send({ title: 'Updated' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Event not found');
  });

  test('PUT /api/events/:id continues when booking sync fails', async () => {
    const updated = { _id: 'evt1', title: 'Updated', venue: 'New', date: new Date(), time: '19:00' };
    Event.findByIdAndUpdate.mockResolvedValue(updated);
    axios.patch.mockRejectedValue(new Error('Booking down'));

    const res = await request(app)
      .put('/api/events/evt1')
      .set('x-test-role', 'admin')
      .send({ title: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Event updated successfully');
  });

  test('PUT /api/events/:id returns 500 on error', async () => {
    Event.findByIdAndUpdate.mockRejectedValue(new Error('DB fail'));

    const res = await request(app)
      .put('/api/events/evt1')
      .set('x-test-role', 'admin')
      .send({ title: 'Updated' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to update event');
  });

  // ---------- DELETE /api/events/:id (admin only) ----------

  test('DELETE /api/events/:id deletes event and cancels bookings', async () => {
    Event.findByIdAndDelete.mockResolvedValue({ _id: 'evt1', title: 'To delete' });
    axios.patch.mockResolvedValue({});

    const res = await request(app)
      .delete('/api/events/evt1')
      .set('x-test-role', 'admin');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Event deleted successfully');
    expect(Event.findByIdAndDelete).toHaveBeenCalledTimes(1);
    expect(axios.patch).toHaveBeenCalledTimes(1);
  });

  test('DELETE /api/events/:id returns 404 when missing', async () => {
    Event.findByIdAndDelete.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/events/missing')
      .set('x-test-role', 'admin');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Event not found');
  });

  test('DELETE /api/events/:id continues when booking cancellation fails', async () => {
    Event.findByIdAndDelete.mockResolvedValue({ _id: 'evt1', title: 'To delete' });
    axios.patch.mockRejectedValue(new Error('Booking fail'));

    const res = await request(app)
      .delete('/api/events/evt1')
      .set('x-test-role', 'admin');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Event deleted successfully');
  });

  test('DELETE /api/events/:id returns 500 on error', async () => {
    Event.findByIdAndDelete.mockRejectedValue(new Error('DB fail'));

    const res = await request(app)
      .delete('/api/events/evt1')
      .set('x-test-role', 'admin');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to delete event');
  });

  // ---------- PATCH /api/events/:id/seats ----------

  test('PATCH /api/events/:id/seats books seats when available', async () => {
    const event = new Event({ _id: 'evt1', capacity: 100, availableSeats: 10 });
    event.save = jest.fn().mockResolvedValue(undefined);
    Event.findById.mockResolvedValue(event);

    const res = await request(app)
      .patch('/api/events/evt1/seats')
      .send({ seatsToBook: 2 });

    expect(res.status).toBe(200);
    expect(res.body.availableSeats).toBe(8);
    expect(event.save).toHaveBeenCalledTimes(1);
  });

  test('PATCH /api/events/:id/seats restores seats on negative seatsToBook', async () => {
    const event = new Event({ _id: 'evt1', capacity: 100, availableSeats: 10 });
    event.save = jest.fn().mockResolvedValue(undefined);
    Event.findById.mockResolvedValue(event);

    const res = await request(app)
      .patch('/api/events/evt1/seats')
      .send({ seatsToBook: -5 });

    expect(res.status).toBe(200);
    expect(res.body.availableSeats).toBe(15);
  });

  test('PATCH /api/events/:id/seats returns 404 when event missing', async () => {
    Event.findById.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/events/missing/seats')
      .send({ seatsToBook: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Event not found');
  });

  test('PATCH /api/events/:id/seats returns 400 when not enough seats', async () => {
    const event = new Event({ _id: 'evt1', capacity: 100, availableSeats: 2 });
    event.save = jest.fn().mockResolvedValue(undefined);
    Event.findById.mockResolvedValue(event);

    const res = await request(app)
      .patch('/api/events/evt1/seats')
      .send({ seatsToBook: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Not enough seats available');
  });

  test('PATCH /api/events/:id/seats returns 500 on error', async () => {
    Event.findById.mockRejectedValue(new Error('DB fail'));

    const res = await request(app)
      .patch('/api/events/evt1/seats')
      .send({ seatsToBook: 1 });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to update seats');
  });

  // ---------- POST /api/events/:id/feedback ----------

  test('POST /api/events/:id/feedback rejects invalid rating', async () => {
    Event.findById.mockResolvedValue({ _id: VALID_EVENT_ID });

    const res = await request(app)
      .post(`/api/events/${VALID_EVENT_ID}/feedback`)
      .set('Authorization', 'Bearer token')
      .send({ rating: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Rating must be between 1 and 5');
  });

  test('POST /api/events/:id/feedback returns 404 when event missing', async () => {
    Event.findById.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/events/${VALID_EVENT_ID}/feedback`)
      .set('Authorization', 'Bearer token')
      .send({ rating: 4 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Event not found');
  });

  test('POST /api/events/:id/feedback rejects when user has no booking', async () => {
    Event.findById.mockResolvedValue({ _id: VALID_EVENT_ID });
    axios.get.mockResolvedValue({ data: { hasBooking: false } });

    const res = await request(app)
      .post(`/api/events/${VALID_EVENT_ID}/feedback`)
      .set('Authorization', 'Bearer token')
      .send({ rating: 4 });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Feedback is limited to attendees with active bookings');
  });

  test('POST /api/events/:id/feedback returns 400 when booking verification fails', async () => {
    Event.findById.mockResolvedValue({ _id: VALID_EVENT_ID });
    axios.get.mockRejectedValue(new Error('Booking fail'));

    const res = await request(app)
      .post(`/api/events/${VALID_EVENT_ID}/feedback`)
      .set('Authorization', 'Bearer token')
      .send({ rating: 4 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unable to verify booking eligibility for feedback');
  });

  test('POST /api/events/:id/feedback returns 400 on duplicate feedback', async () => {
    Event.findById.mockResolvedValue({ _id: VALID_EVENT_ID });
    axios.get.mockResolvedValue({ data: { hasBooking: true, bookingStatus: 'confirmed' } });
    Feedback.create.mockRejectedValue({ code: 11000 });

    const res = await request(app)
      .post(`/api/events/${VALID_EVENT_ID}/feedback`)
      .set('Authorization', 'Bearer token')
      .send({ rating: 4 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('You have already submitted feedback for this event');
  });

  test('POST /api/events/:id/feedback creates feedback successfully', async () => {
    Event.findById.mockResolvedValue({ _id: VALID_EVENT_ID });
    axios.get.mockResolvedValue({ data: { hasBooking: true, bookingStatus: 'confirmed' } });

    const feedback = {
      _id: 'fb1',
      eventId: VALID_EVENT_ID,
      userId: 'user1',
      rating: 5,
      comment: 'Great',
    };

    Feedback.create.mockResolvedValue(feedback);

    const res = await request(app)
      .post(`/api/events/${VALID_EVENT_ID}/feedback`)
      .set('Authorization', 'Bearer token')
      .send({ rating: 5, comment: 'Great' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Feedback submitted successfully');
  });

  test('POST /api/events/:id/feedback returns 500 on unexpected error', async () => {
    Event.findById.mockResolvedValue({ _id: VALID_EVENT_ID });
    axios.get.mockResolvedValue({ data: { hasBooking: true, bookingStatus: 'confirmed' } });
    Feedback.create.mockRejectedValue(new Error('DB fail'));

    const res = await request(app)
      .post(`/api/events/${VALID_EVENT_ID}/feedback`)
      .set('Authorization', 'Bearer token')
      .send({ rating: 4 });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to submit feedback');
  });

  // ---------- GET /api/events/:id/feedback ----------

  test('GET /api/events/:id/feedback returns feedback and stats', async () => {
    const items = [
      { _id: 'fb1', eventId: VALID_EVENT_ID, rating: 4 },
      { _id: 'fb2', eventId: VALID_EVENT_ID, rating: 5 },
    ];

    Feedback.find.mockReturnValue(buildFeedbackFindChain(items));
    Feedback.aggregate
      .mockResolvedValueOnce([
        {
          averageRating: 4.5,
          total: 2,
          ratingBreakdown: [4, 5],
        },
      ]);

    const res = await request(app).get(`/api/events/${VALID_EVENT_ID}/feedback`);

    expect(res.status).toBe(200);
    expect(res.body.stats.total).toBe(2);
    expect(res.body.stats.averageRating).toBe(4.5);
  });

  test('GET /api/events/:id/feedback returns zero stats when no feedback', async () => {
    Feedback.find.mockReturnValue(buildFeedbackFindChain([]));
    Feedback.aggregate
      .mockResolvedValueOnce([]);

    const res = await request(app).get(`/api/events/${VALID_EVENT_ID}/feedback`);

    expect(res.status).toBe(200);
    expect(res.body.stats.total).toBe(0);
    expect(res.body.stats.averageRating).toBe(0);
  });

  test('GET /api/events/:id/feedback returns 500 on error', async () => {
    Feedback.find.mockImplementation(() => {
      throw new Error('DB fail');
    });

    const res = await request(app).get(`/api/events/${VALID_EVENT_ID}/feedback`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch feedback');
  });

  // ---------- PUT /api/events/:id/feedback/:feedbackId ----------

  test('PUT /api/events/:id/feedback/:id rejects invalid rating', async () => {
    const res = await request(app)
      .put(`/api/events/${VALID_EVENT_ID}/feedback/fb1`)
      .send({ rating: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Rating must be between 1 and 5');
  });

  test('PUT /api/events/:id/feedback/:id returns 404 when feedback missing', async () => {
    Feedback.findById.mockResolvedValue(null);

    const res = await request(app)
      .put(`/api/events/${VALID_EVENT_ID}/feedback/fb1`)
      .send({ rating: 4 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Feedback not found');
  });

  test('PUT /api/events/:id/feedback/:id rejects when user is not owner', async () => {
    const feedback = new Feedback({ _id: 'fb1', userId: 'other' });
    feedback.save = jest.fn().mockResolvedValue(undefined);
    Feedback.findById.mockResolvedValue(feedback);

    const res = await request(app)
      .put(`/api/events/${VALID_EVENT_ID}/feedback/fb1`)
      .set('x-test-user-id', 'user1')
      .send({ rating: 4 });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('You can only edit your own feedback');
  });

  test('PUT /api/events/:id/feedback/:id updates feedback', async () => {
    const feedback = new Feedback({
      _id: 'fb1',
      userId: 'user1',
      rating: 3,
      comment: 'ok',
    });
    feedback.save = jest.fn().mockResolvedValue(undefined);
    Feedback.findById.mockResolvedValue(feedback);

    const res = await request(app)
      .put(`/api/events/${VALID_EVENT_ID}/feedback/fb1`)
      .set('x-test-user-id', 'user1')
      .send({ rating: 5, comment: 'better' });

    expect(res.status).toBe(200);
    expect(res.body.feedback.rating).toBe(5);
    expect(res.body.feedback.isEdited).toBe(true);
  });

  test('PUT /api/events/:id/feedback/:id returns 500 on error', async () => {
    Feedback.findById.mockRejectedValue(new Error('DB fail'));

    const res = await request(app)
      .put(`/api/events/${VALID_EVENT_ID}/feedback/fb1`)
      .send({ rating: 4 });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to update feedback');
  });

  // ---------- DELETE /api/events/:id/feedback/:feedbackId ----------

  test('DELETE /api/events/:id/feedback/:id returns 404 when missing', async () => {
    Feedback.findById.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/events/${VALID_EVENT_ID}/feedback/fb1`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Feedback not found');
  });

  test('DELETE /api/events/:id/feedback/:id rejects when user is not owner', async () => {
    const feedback = new Feedback({ _id: 'fb1', userId: 'other' });
    Feedback.findById.mockResolvedValue(feedback);

    const res = await request(app)
      .delete(`/api/events/${VALID_EVENT_ID}/feedback/fb1`)
      .set('x-test-user-id', 'user1');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('You can only delete your own feedback');
  });

  test('DELETE /api/events/:id/feedback/:id deletes feedback', async () => {
    const feedback = new Feedback({ _id: 'fb1', userId: 'user1' });
    Feedback.findById.mockResolvedValue(feedback);
    Feedback.findByIdAndDelete.mockResolvedValue(undefined);

    const res = await request(app)
      .delete(`/api/events/${VALID_EVENT_ID}/feedback/fb1`)
      .set('x-test-user-id', 'user1');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Feedback deleted successfully');
  });

  test('DELETE /api/events/:id/feedback/:id returns 500 on error', async () => {
    Feedback.findById.mockRejectedValue(new Error('DB fail'));

    const res = await request(app)
      .delete(`/api/events/${VALID_EVENT_ID}/feedback/fb1`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to delete feedback');
  });

  // ---------- GET /api/events/analytics/summary (admin only) ----------

  test('GET /api/events/analytics/summary returns analytics for admin', async () => {
    Event.countDocuments
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(5)  // upcoming
      .mockResolvedValueOnce(2)  // ongoing
      .mockResolvedValueOnce(2)  // completed
      .mockResolvedValueOnce(1); // cancelled

    Feedback.aggregate
      .mockResolvedValueOnce([
        {
          eventId: VALID_EVENT_ID,
          title: 'Top Event',
          averageRating: 4.8,
          totalFeedback: 10,
        },
      ])
      .mockResolvedValueOnce([
        {
          averageRating: 4.5,
          totalFeedback: 20,
        },
      ]);

    const res = await request(app)
      .get('/api/events/analytics/summary')
      .set('x-test-role', 'admin');

    expect(res.status).toBe(200);
    expect(res.body.events.totalEvents).toBe(10);
    expect(res.body.feedback.totalFeedback).toBe(20);
  });

  test('GET /api/events/analytics/summary returns 403 for non-admin', async () => {
    const res = await request(app)
      .get('/api/events/analytics/summary');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access denied. Admin only.');
  });

  test('GET /api/events/analytics/summary returns 500 on error', async () => {
    Event.countDocuments.mockRejectedValue(new Error('DB fail'));

    const res = await request(app)
      .get('/api/events/analytics/summary')
      .set('x-test-role', 'admin');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch analytics');
  });
});
