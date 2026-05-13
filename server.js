require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

if (!process.env.JWT_SECRET) {
  console.error("❌ JWT_SECRET is not set. Check your .env file.");
  process.exit(1);
}

if (!process.env.MONGODB_URI) {
  console.error("❌ MONGODB_URI is not set. Check your .env file.");
  process.exit(1);
}

const app = express();

app.use(cors());
app.use(express.json());

// Health check — also acts as keep-alive ping target for cron-job.org
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/slots", require("./routes/slots"));

// Connect DB + Start
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("MongoDB connected");
    app.listen(process.env.PORT || 5000, () => {
      console.log(`Server running on port ${process.env.PORT || 5000}`);
    });
  })
  .catch((err) => console.error(err));
