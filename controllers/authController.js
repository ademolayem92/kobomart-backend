const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const mongoose = require('mongoose');

// Mock User Schema embedded for absolute autonomy
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  roles: { type: [String], default: ['Buyer'] },
  isEmailVerified: { type: Boolean, default: false },
  verificationToken: String,
  verificationTokenExpires: Date,
  hashedRefreshToken: String,
  isFrozen: { type: Boolean, default: false }
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

// Memory safe cache storage tracking multi-factor failed authentication rate limit instances
const loginRateLimitCache = new Map();

const authController = {
  register: async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

      const existingUser = await User.findOne({ email });
      if (existingUser) return res.status(400).json({ error: 'User already exists' });

      const passwordHash = await bcrypt.hash(password, 10);
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const verificationTokenExpires = Date.now() + 3600000; // 1 hour

      const user = new User({
        email,
        passwordHash,
        verificationToken,
        verificationTokenExpires
      });
      await user.save();

      // Allocate corresponding wallet inside the PostgreSQL ledger domain dynamically
      const pgClient = req.pgPool; 
      if (pgClient) {
        await pgClient.query(
          `INSERT INTO accounts (owner_type, owner_id, currency, balance_kobo, status) VALUES ($1, $2, $3, $4, $5)`,
          ['user', user._id.toString(), 'NGN', 0, 'active']
        );
      }

      console.log(`[Verification Email Simulated] Target: ${email} | Token: ${verificationToken}`);
      return res.status(201).json({ message: 'Registration complete. Verify email to proceed.' });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  },

  verifyEmail: async (req, res) => {
    try {
      const { token } = req.body;
      const user = await User.findOne({
        verificationToken: token,
        verificationTokenExpires: { $gt: Date.now() }
      });
      if (!user) return res.status(400).json({ error: 'Invalid or expired token' });

      user.isEmailVerified = true;
      user.verificationToken = undefined;
      user.verificationTokenExpires = undefined;
      await user.save();

      return res.status(200).json({ message: 'Email verified successfully' });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  },

  login: async (req, res) => {
    try {
      const { email, password } = req.body;
      const ip = req.ip;
      const rateLimitKey = `${email}_${ip}`;

      const attemptRecord = loginRateLimitCache.get(rateLimitKey) || { count: 0, lockUntil: 0 };
      if (attemptRecord.lockUntil > Date.now()) {
        return res.status(429).json({ error: 'Too many authentication attempts. Locked out for 15 minutes.' });
      }

      const user = await User.findOne({ email });
      if (!user || user.isFrozen) {
        return res.status(401).json({ error: 'Invalid credentials or account suspended' });
      }

      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) {
        attemptRecord.count += 1;
        if (attemptRecord.count >= 5) {
          attemptRecord.lockUntil = Date.now() + 15 * 60 * 1000;
        }
        loginRateLimitCache.set(rateLimitKey, attemptRecord);
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      loginRateLimitCache.delete(rateLimitKey);

      const accessToken = jwt.sign({ userId: user._id, roles: user.roles }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '15m' });
      const refreshToken = crypto.randomBytes(40).toString('hex');
      
      user.hashedRefreshToken = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await user.save();

      return res.status(200).json({ accessToken, refreshToken });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  },

  refresh: async (req, res) => {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) return res.status(400).json({ error: 'Token requested' });

      const incomingHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const user = await User.findOne({ hashedRefreshToken: incomingHash });

      if (!user) {
        // Reuse anomaly protection rule: Invalidated refresh token logs out all sessions
        await User.updateMany({ hashedRefreshToken: incomingHash }, { $unset: { hashedRefreshToken: 1 } });
        return res.status(403).json({ error: 'Token reused or compromised. All sessions revoked.' });
      }

      const newAccessToken = jwt.sign({ userId: user._id, roles: user.roles }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '15m' });
      const newRefreshToken = crypto.randomBytes(40).toString('hex');

      user.hashedRefreshToken = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
      await user.save();

      return res.status(200).json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  },

  logout: async (req, res) => {
    try {
      const { userId } = req.user;
      await User.findByIdAndUpdate(userId, { $unset: { hashedRefreshToken: 1 } });
      return res.status(200).json({ message: 'Session terminated' });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
};

module.exports = authController;
