const mongoose = require("mongoose");

const playerSchema = new mongoose.Schema({
  name: { type: String, default: "" },
  identifier: { type: String, default: "" }, // email OR phone — whichever the user registered with
  bookedBy: { type: String, default: "" },
  timeStamp: { type: String, default: "" },
  payment: { type: Boolean, default: false },
  playerAmt: { type: Number, default: 0 },
});

const slotSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },
    time: { type: String, required: true },
    courtNo: { type: Number, default: 0 },
    slotLocked: { type: Boolean, default: false },
    slotHidden: { type: Boolean, default: false },
    slotArchived: { type: Boolean, default: false },
    players: { type: [playerSchema], default: () => Array(6).fill({}) },
    waitList: { type: [playerSchema], default: () => Array(4).fill({}) },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Slot", slotSchema);
