const router = require("express").Router();
const auth = require("../middleware/auth");
const User = require("../models/User");

// GET /api/users  — admin only
router.get("/", auth, async (req, res) => {
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
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found." });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
