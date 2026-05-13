const jwt = require("jsonwebtoken");

module.exports = function (req, res, next) {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // decoded now has { id, identifier, role }
    // keep req.user.email as an alias so existing code that reads req.user.email
    // still works — it will be null for phone-only users
    req.user = {
      ...decoded,
      email: decoded.email ?? decoded.identifier ?? null,
    };

    if (next) next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
};
