const jwt = require('jsonwebtoken');

const authMiddleware = (requiredRoles = []) => {
  return (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authorization header missing or malformed' });
      }

      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
      
      req.user = decoded; 

      if (requiredRoles.length > 0) {
        const hasRole = requiredRoles.some(role => req.user.roles && req.user.roles.includes(role));
        if (!hasRole) {
          return res.status(403).json({ error: 'Access denied: Insufficient privileges' });
        }
      }

      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired authorization token' });
    }
  };
};

module.exports = authMiddleware;
