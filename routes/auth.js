const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const User = require("../models/User");
const { parsePhoneNumber, isValidPhoneNumber } = require("libphonenumber-js");

// ─── helpers ──────────────────────────────────────────────────────────────────

function normalisePhone(raw) {
  try {
    const phone = parsePhoneNumber(raw);
    return phone.number;
  } catch {
    return raw;
  }
}

function isPhone(raw) {
  try {
    if (!raw.trim().startsWith("+")) return false;
    return isValidPhoneNumber(raw);
  } catch {
    return false;
  }
}

function isEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

/**
 * Generates a 6-character reset key: uppercase letters + digits only.
 * Excludes O/0 and I/1 to avoid visual confusion.
 * e.g. "X78A30", "B4K9ZQ"
 */
function generateResetKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let key = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    key += chars[bytes[i] % chars.length];
  }
  return key;
}

// ─── REGISTER ─────────────────────────────────────────────────────────────────

router.post("/register", async (req, res) => {
  try {
    const { firstName, lastName, email, phone, password } = req.body;

    if (!email && !phone) {
      return res
        .status(400)
        .json({ message: "Please provide an email or phone number." });
    }
    if (email && !isEmail(email)) {
      return res
        .status(400)
        .json({ message: "Please enter a valid email address." });
    }
    if (phone) {
      if (!phone.trim().startsWith("+")) {
        return res.status(400).json({
          message:
            "Please include your country code (e.g. +1 for Canada/US, +44 for UK, +91 for India).",
        });
      }
      if (!isPhone(phone)) {
        return res.status(400).json({
          message:
            "Please enter a valid phone number including your country code (e.g. +1 604 555 0123).",
        });
      }
    }

    const normalisedPhone = phone ? normalisePhone(phone) : undefined;

    if (email) {
      const existingEmail = await User.findOne({ email });
      if (existingEmail)
        return res.status(400).json({ message: "Email already registered." });
    }
    if (normalisedPhone) {
      const existingPhone = await User.findOne({ phone: normalisedPhone });
      if (existingPhone)
        return res
          .status(400)
          .json({ message: "Phone number already registered." });
    }

    const name = `${firstName.trim()} ${lastName.trim()}`;
    const hashed = await bcrypt.hash(password, 10);
    const resetKey = generateResetKey();

    const user = await User.create({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      name,
      email: email ? email.toLowerCase().trim() : undefined,
      phone: normalisedPhone ?? undefined,
      password: hashed,
      resetKey,
      profileApproved: false,
      lastLogin: "",
    });

    res.json({
      success: true,
      resetKey,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────

router.post("/login", async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier) {
      return res
        .status(400)
        .json({ message: "Please enter your email or phone number." });
    }

    let user;
    if (isEmail(identifier)) {
      user = await User.findOne({ email: identifier.toLowerCase().trim() });
    } else {
      user = await User.findOne({ phone: normalisePhone(identifier) });
    }

    if (!user)
      return res.status(400).json({ message: "Invalid username or password." });

    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(400).json({ message: "Invalid username or password." });

    if (!user.profileApproved) {
      return res.status(403).json({ code: "PENDING_APPROVAL" });
    }

    await User.findByIdAndUpdate(user._id, {
      lastLogin: new Date().toISOString(),
    });

    const userIdentifier = user.email ?? user.phone;
    const token = jwt.sign(
      { id: user._id, identifier: userIdentifier, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.json({
      token,
      user: {
        name: user.name,
        identifier: userIdentifier,
        email: user.email ?? undefined,
        phone: user.phone ?? undefined,
        role: user.role,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── RESET PASSWORD BY KEY ────────────────────────────────────────────────────
// POST /auth/reset-by-key  { identifier, resetKey, newPassword }
//
// Verifies the stored reset key, updates the password, and rotates the key.
// Returns the new key so the user can save it immediately.

router.post("/reset-by-key", async (req, res) => {
  try {
    const { identifier, resetKey, newPassword } = req.body;

    if (!identifier || !resetKey || !newPassword) {
      return res.status(400).json({ message: "All fields are required." });
    }
    if (newPassword.length < 8) {
      return res
        .status(400)
        .json({ message: "Password must be at least 8 characters." });
    }

    let user;
    if (isEmail(identifier)) {
      user = await User.findOne({ email: identifier.toLowerCase().trim() });
    } else {
      user = await User.findOne({ phone: normalisePhone(identifier) });
    }

    // Generic message — don't reveal whether the account exists
    const INVALID = "Invalid email/phone or reset key.";
    if (!user) return res.status(400).json({ message: INVALID });
    if (
      !user.resetKey ||
      user.resetKey.toUpperCase() !== resetKey.trim().toUpperCase()
    ) {
      return res.status(400).json({ message: INVALID });
    }

    // Rotate key and update password atomically
    const newKey = generateResetKey();
    const hashed = await bcrypt.hash(newPassword, 10);

    await User.findByIdAndUpdate(user._id, {
      password: hashed,
      resetKey: newKey,
    });

    res.json({ success: true, newResetKey: newKey });
  } catch (err) {
    console.error("reset-by-key error:", err);
    res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
});

module.exports = router;
