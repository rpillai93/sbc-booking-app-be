const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    name: { type: String, required: true },
    email: {
      type: String,
      default: undefined,
      unique: true,
      sparse: true,
    },
    phone: {
      type: String,
      default: undefined,
      unique: true,
      sparse: true,
    },
    password: { type: String, required: true },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    // 6-character alphanumeric key used for self-service password reset.
    // Stored in plaintext so admins can look it up directly if needed.
    // Rotated on every successful password reset.
    resetKey: { type: String, default: undefined },
    profileApproved: { type: Boolean, default: false },
    lastLogin: { type: String, default: "" },
  },
  { timestamps: true },
);

// enforce: at least one of email or phone must be present
userSchema.pre("validate", function (next) {
  if (!this.email && !this.phone) {
    this.invalidate(
      "email",
      "At least one of email or phone number is required.",
    );
  }
  if (next) next();
});

module.exports = mongoose.model("User", userSchema);
