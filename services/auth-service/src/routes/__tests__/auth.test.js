const request = require('supertest');
const express = require('express');


jest.mock('../../models/User', () => {
  const mockUserConstructor = function (userData) {
    return {
      ...userData,
      _id: 'mock-user-id',
      save: jest.fn().mockResolvedValue(undefined),
      comparePassword: jest.fn(),
    };
  };


  mockUserConstructor.findOne = jest.fn();
  mockUserConstructor.findById = jest.fn();
  mockUserConstructor.find = jest.fn();

  return mockUserConstructor;
});


jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'fake-jwt-token'),
  verify: jest.fn(),
}));

const authRouter = require('../auth');
const debugRouter = require('../debug');
const User = require('../../models/User');
const jwt = require('jsonwebtoken');


function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/debug', debugRouter);
  return app;
}

describe('Auth Service Routes', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
  });



  test('POST /api/auth/register returns 400 if required fields are missing', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@umd.edu' }); 

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Name, email, and password are required/i);
  });

  test('POST /api/auth/register rejects non-UMD emails', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Test User',
        email: 'test@gmail.com',
        password: 'password123',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/@umd\.edu/);
  });

  test('POST /api/auth/register enforces minimum password length', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Test User',
        email: 'test@umd.edu',
        password: '123',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Password must be at least 6 characters/i);
  });

  test('POST /api/auth/register returns 400 if email already exists', async () => {
    User.findOne.mockResolvedValue({
      _id: 'existing-id',
      email: 'test@umd.edu',
    });

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Test User',
        email: 'test@umd.edu',
        password: 'password123',
      });

    expect(User.findOne).toHaveBeenCalledWith({ email: 'test@umd.edu' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Email already registered/i);
  });

  test('POST /api/auth/register creates a new user and returns token', async () => {
    // No existing user
    User.findOne.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'New User',
        email: 'newuser@umd.edu',
        password: 'password123',
        role: 'user',
      });

    expect(User.findOne).toHaveBeenCalledWith({ email: 'newuser@umd.edu' });
   
    expect(res.status).toBe(201);
    expect(jwt.sign).toHaveBeenCalled(); 
    expect(res.body).toHaveProperty('token', 'fake-jwt-token');
    expect(res.body.user).toMatchObject({
      name: 'New User',
      email: 'newuser@umd.edu',
      role: 'user',
    });
  });



  test('POST /api/auth/login returns 400 when email or password is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@umd.edu' }); 

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Email and password are required/i);
  });

  test('POST /api/auth/login returns 401 when user is not found', async () => {
    User.findOne.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'missing@umd.edu',
        password: 'password123',
      });

    expect(User.findOne).toHaveBeenCalledWith({ email: 'missing@umd.edu' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid email or password/i);
  });

  test('POST /api/auth/login returns 401 when password is incorrect', async () => {
    const mockCompare = jest.fn().mockResolvedValue(false);

    User.findOne.mockResolvedValue({
      _id: 'user-id',
      name: 'Test User',
      email: 'test@umd.edu',
      role: 'user',
      comparePassword: mockCompare,
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'test@umd.edu',
        password: 'wrongpassword',
      });

    expect(mockCompare).toHaveBeenCalledWith('wrongpassword');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid email or password/i);
  });

  test('POST /api/auth/login returns 200 and token on valid credentials', async () => {
    const mockCompare = jest.fn().mockResolvedValue(true);

    User.findOne.mockResolvedValue({
      _id: 'user-id',
      name: 'Test User',
      email: 'test@umd.edu',
      role: 'admin',
      comparePassword: mockCompare,
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'test@umd.edu',
        password: 'password123',
      });

    expect(mockCompare).toHaveBeenCalledWith('password123');
    expect(res.status).toBe(200);
    expect(jwt.sign).toHaveBeenCalled();
    expect(res.body).toHaveProperty('token', 'fake-jwt-token');
    expect(res.body.user).toMatchObject({
      id: 'user-id',
      name: 'Test User',
      email: 'test@umd.edu',
      role: 'admin',
    });
  });

 

  test('GET /api/auth/verify returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/auth/verify');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/No token provided/i);
  });

  test('GET /api/auth/verify returns 401 when token is invalid', async () => {
   
    jwt.verify.mockImplementation(() => {
      throw new Error('invalid token');
    });

    const res = await request(app)
      .get('/api/auth/verify')
      .set('Authorization', 'Bearer invalidtoken');

    expect(jwt.verify).toHaveBeenCalled();
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid token/i);
  });

  test('GET /api/auth/verify returns user when token is valid', async () => {
    jwt.verify.mockReturnValue({ id: 'user-id', role: 'user' });

    const mockSelect = jest.fn().mockResolvedValue({
      _id: 'user-id',
      name: 'Verified User',
      email: 'verified@umd.edu',
      role: 'user',
    });

    User.findById.mockReturnValue({
      select: mockSelect,
    });

    const res = await request(app)
      .get('/api/auth/verify')
      .set('Authorization', 'Bearer validtoken');

    expect(jwt.verify).toHaveBeenCalledWith('validtoken', expect.any(String));
    expect(User.findById).toHaveBeenCalledWith('user-id');
    expect(mockSelect).toHaveBeenCalledWith('-password');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      valid: true,
      user: {
        _id: 'user-id',
        name: 'Verified User',
        email: 'verified@umd.edu',
        role: 'user',
      },
    });
  });
});

describe('Debug Routes', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
  });

  test('GET /api/debug/users returns user list', async () => {
    const mockSelect = jest.fn().mockResolvedValue([
      { _id: 'u1', email: 'one@umd.edu' },
      { _id: 'u2', email: 'two@umd.edu' },
    ]);

    User.find.mockReturnValue({
      select: mockSelect,
    });

    const res = await request(app).get('/api/debug/users');

    expect(User.find).toHaveBeenCalledWith({});
    expect(mockSelect).toHaveBeenCalledWith('-password');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  test('GET /api/debug/users returns 500 on error', async () => {
    const mockSelect = jest.fn().mockRejectedValue(new Error('DB error'));

    User.find.mockReturnValue({
      select: mockSelect,
    });

    const res = await request(app).get('/api/debug/users');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/DB error/i);
  });
});
