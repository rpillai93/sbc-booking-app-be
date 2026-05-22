const router = require("express").Router();
const auth = require("../middleware/auth");
const User = require("../models/User");
const { isAdmin } = require("../middleware/helpers");

// GET /api/users  — admin only
router.get("/", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });
  try {
    const users = await User.find({}, "-password -resetKey").sort({
      createdAt: -1,
    });
    res.json({ users });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/users/:id/approve  — admin only
router.patch("/:id/approve", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { profileApproved: true },
      { returnDocument: "after", select: "-password -resetKey" },
    );
    if (!user) return res.status(404).json({ message: "User not found." });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/users/:id/comment  — admin only
router.patch("/:id/comment", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });
  try {
    const user = await User.findByIdAndUpdate(req.params.id, {
      comments: req.body.comments ?? "",
    });
    if (!user) return res.status(404).json({ message: "User not found." });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/users/:id  — admin only
router.delete("/:id", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found." });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/users/:id/settle — admin only
router.patch("/:id/settle", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });

  try {
    const { amount } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found." });
    user.balancePayments =
      amount < 0.05
        ? 0
        : Math.round((user.balancePayments - amount) * 100) / 100;
    await user.save();
    res.json({ user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/users/me — any authenticated user
router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id, "-password -resetKey");
    if (!user) return res.status(404).json({ message: "User not found." });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
