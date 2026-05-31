const mongoose = require("mongoose");

const playerSchema = new mongoose.Schema({
  name: { type: String, default: "" },
  ownerIdentifier: { type: String, default: "" }, // email OR phone — whichever the user registered with
  ownerName: { type: String, default: "" },
  lastUpdatedIdentifier: { type: String, default: "" }, // email OR phone — whichever the user registered with
  timeStamp: { type: String, default: "" },
  payment: { type: Boolean, default: false },
  playerAmt: { type: Number, default: 0 },
});

const slotSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },
    time: { type: String, required: true },
    courtNo: { type: Number, default: 0 },
    numberOfCourts: { type: Number, default: 0 },
    groupId: { type: String, required: true },
    slotLocked: { type: Boolean, default: false },
    slotHidden: { type: Boolean, default: false },
    slotArchived: { type: Boolean, default: false },
    slotAmountPublished: { type: Boolean, default: false },
    slotTotalAmount: { type: Number, default: 0 },
    players: { type: [playerSchema], default: () => Array(6).fill({}) },
    waitList: { type: [playerSchema], default: () => Array(4).fill({}) },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Slot", slotSchema);
