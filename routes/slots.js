const router = require("express").Router();
const Slot = require("../models/Slot");
const User = require("../models/User");
const auth = require("../middleware/auth");
const { isAdmin, formatDateForServer } = require("../middleware/helpers");
const logger = require("../utils/logger");

// GET all slots (grouped) — replaces getSlots()
router.get("/", auth, async (req, res) => {
  try {
    const slots = await Slot.find().sort({ date: 1 });

    const grouped = {};
    slots.forEach((slot) => {
      const key = `${slot.date}__${slot.time}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(slot);
    });

    res.json({ sortedSlots: slots, groupedSlots: grouped });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST create slot(s) — admin only
router.post("/", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });
  try {
    const { date, time, courts } = req.body;
    const count = Number(courts) || 1;
    const created = [];
    const dateFormatted = formatDateForServer(date);

    for (let i = 0; i < count; i++) {
      const slot = await Slot.create({
        date: dateFormatted,
        time,
        players: Array(6).fill({}),
        waitList: Array(4).fill({}),
      });
      created.push(slot);
    }
    res.json({ success: true, count: created.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE slot — admin only
router.delete("/:id", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });

  try {
    await Slot.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch("/:id/player", auth, async (req, res) => {
  try {
    const { playerIndex, name, lastUpdatedAt } = req.body;
    const identifier = req.user.identifier;

    // fetch acting user's first name for the bookedBy audit field
    const actingUser = await User.findById(req.user.id).select("firstName");
    const bookedBy = actingUser?.firstName ?? identifier;

    const slot = await Slot.findById(req.params.id);
    if (!slot) return res.status(404).json({ message: "Slot not found" });

    // ── GUARD 1: timestamp check ─────────────────────────────────────────────
    // Reject if the slot document was modified by anyone since this user
    // last loaded the page.
    if (
      lastUpdatedAt &&
      new Date(lastUpdatedAt).getTime() !== slot.updatedAt.getTime()
    ) {
      return res.status(409).json({
        message:
          "This slot was recently updated by someone else. Please refresh and try again.",
        conflict: true,
      });
    }

    const PLAYER_COUNT = 6;
    const ts = new Date().toISOString();

    const isWaitlist = playerIndex >= PLAYER_COUNT;

    // ── GUARD 2: ownership check ─────────────────────────────────────────────
    // At this point Guard 2 guarantees the target position is either empty
    // or belongs to the current user. This check handles the remaining case:
    // removals, where an occupied slot is intentionally targeted.
    // Admins may remove any booking; regular users may only remove their own.
    if (!isAdmin(req)) {
      const target = isWaitlist
        ? slot.waitList[playerIndex - PLAYER_COUNT]
        : slot.players[playerIndex];

      if (target?.identifier && target.identifier !== identifier) {
        return res.status(403).json({
          message:
            "You can only modify your own booking. Speak to an admin to make changes.",
        });
      }
    }

    // ── WRITE ────────────────────────────────────────────────────────────────
    const isRemovingPlayer = (!name || name.trim() === "") && !isWaitlist;

    if (isRemovingPlayer) {
      let promoted = {
        name: "",
        identifier: "",
        bookedBy: "",
        timeStamp: "",
        payment: false,
        playerAmt: 0,
      };
      const index = slot.waitList.findIndex((p) => p.name?.trim());
      if (index !== -1) {
        promoted = slot.waitList.splice(index, 1)[0];
        slot.waitList.push({
          name: "",
          identifier: "",
          bookedBy: "",
          timeStamp: "",
          payment: false,
          playerAmt: 0,
        });
        slot.waitList.sort(
          (a, b) => (!a.name?.trim() ? 1 : 0) - (!b.name?.trim() ? 1 : 0),
        );
      }
      slot.players[playerIndex] = promoted;
    } else if (isWaitlist) {
      const wlIndex = playerIndex - PLAYER_COUNT;
      if (!name || name.trim() === "") {
        // removing from waitlist
        slot.waitList.splice(wlIndex, 1);
        slot.waitList.push({
          name: "",
          identifier: "",
          bookedBy: "",
          timeStamp: "",
          payment: false,
          playerAmt: 0,
        });
      } else if (!slot.waitList[wlIndex]?.name) {
        // filling an empty waitlist spot
        slot.waitList[wlIndex] = {
          name,
          identifier,
          bookedBy,
          timeStamp: ts,
          payment: false,
          playerAmt: 0,
        };
      } else {
        // updating own existing waitlist entry
        slot.waitList[wlIndex] = {
          name,
          identifier,
          bookedBy,
          timeStamp: ts,
          payment: slot.waitList[wlIndex].payment,
          playerAmt: slot.waitList[wlIndex].playerAmt,
        };
      }
    } else {
      slot.players[playerIndex] = {
        name,
        identifier,
        bookedBy,
        timeStamp: ts,
        payment: false,
        playerAmt: 0,
      };
    }

    slot.markModified("players");
    slot.markModified("waitList");
    await slot.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH update individual playerAmts — admin only
// totalAmt is computed as sum of all playerAmts and stored for reference
router.patch("/:id/amount", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });
  try {
    const { players = [], waitList = [] } = req.body;

    const slot = await Slot.findById(req.params.id);
    if (!slot) return res.status(404).json({ message: "Slot not found" });

    const playerMap = new Map(players.map((p) => [String(p._id), p.playerAmt]));
    const waitListMap = new Map(
      waitList.map((p) => [String(p._id), p.playerAmt]),
    );

    let playersModified = false;
    let waitListModified = false;

    slot.players.forEach((sp) => {
      const amt = playerMap.get(String(sp._id));
      if (amt !== undefined) {
        sp.playerAmt = amt;
        playersModified = true;
      }
    });

    slot.waitList.forEach((swp) => {
      const amt = waitListMap.get(String(swp._id));
      if (amt !== undefined) {
        swp.playerAmt = amt;
        waitListModified = true;
      }
    });

    if (playersModified) slot.markModified("players");
    if (waitListModified) slot.markModified("waitList");

    await slot.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH update payment status
router.patch("/:id/payment", auth, async (req, res) => {
  try {
    const { playerIndex, paymentStatus, lastUpdatedAt } = req.body;
    const slot = await Slot.findById(req.params.id);
    // ── GUARD 1: timestamp check ─────────────────────────────────────────────
    // Reject if the slot document was modified by anyone since this user
    // last loaded the page (this can happen if an admin is trying to
    // update a player's payment)
    if (
      lastUpdatedAt &&
      new Date(lastUpdatedAt).getTime() !== slot.updatedAt.getTime()
    ) {
      return res.status(409).json({
        message:
          "This slot was recently updated by someone else. Please refresh and try again.",
        conflict: true,
      });
    }

    const identifier = req.user.identifier;

    if (!slot) return res.status(404).json({ message: "Slot not found" });

    const PLAYER_COUNT = 6;
    const isWaitlist = playerIndex >= PLAYER_COUNT;

    if (!isAdmin(req)) {
      const target = isWaitlist
        ? slot.waitList[playerIndex - PLAYER_COUNT]
        : slot.players[playerIndex];
      if (target?.identifier && target.identifier !== identifier) {
        return res
          .status(403)
          .json({ message: "You can only update your own payment" });
      }
    }

    if (isWaitlist) {
      slot.waitList[playerIndex - PLAYER_COUNT].payment = paymentStatus;
      slot.markModified("waitList");
    } else {
      slot.players[playerIndex].payment = paymentStatus;
      slot.markModified("players");
    }

    await slot.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH lock/unlock — admin only
router.patch("/:id/lock", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });
  try {
    await Slot.findByIdAndUpdate(req.params.id, {
      slotLocked: req.body.isLocked,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH hide/show — admin only
router.patch("/:id/hide", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });
  try {
    await Slot.findByIdAndUpdate(req.params.id, {
      slotHidden: req.body.isHidden,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH archive/unarchive — admin only
router.patch("/:id/archive", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });
  try {
    const { isArchived } = req.body;
    await Slot.findByIdAndUpdate(req.params.id, {
      slotArchived: isArchived,
      slotLocked: isArchived ? true : undefined,
      slotHidden: isArchived ? true : undefined,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH update court number — admin only
router.patch("/:id/courtno", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });
  try {
    const courtNo = Number(req.body.courtNo);
    if (!Number.isInteger(courtNo) || courtNo < 1 || courtNo > 9) {
      return res
        .status(400)
        .json({ message: "Court number must be between 1 and 9." });
    }
    await Slot.findByIdAndUpdate(req.params.id, { courtNo });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/slots/auto-lock — called by cron job every hour
router.post("/auto-lock", async (req, res) => {
  const secret = req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const slots = await Slot.find({ slotLocked: false, slotArchived: false });
    let lockedCount = 0;

    for (const slot of slots) {
      const slotDateTime = parseSlotDateTime(slot.date, slot.time);
      if (!slotDateTime) continue;

      if (slotDateTime <= in24Hours) {
        await Slot.findByIdAndUpdate(slot._id, { slotLocked: true });
        lockedCount++;
      }
    }

    console.log(
      `[auto-lock] ${new Date().toISOString()} — locked ${lockedCount} slot(s)`,
    );
    res.json({ success: true, lockedCount, checkedAt: now.toISOString() });
  } catch (err) {
    console.error("[auto-lock] error:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// Parses "SATURDAY, 16-MAY-2026" + "6:00 PM–8:00 PM" into a Date
function parseSlotDateTime(dateStr, timeStr) {
  try {
    // extract start time from "6:00 PM–8:00 PM"
    const startTime = timeStr.split("–")[0].trim(); // "6:00 PM"

    // convert "SATURDAY, 16-MAY-2026" → "16 MAY 2026"
    const datePart = dateStr.split(",")[1].trim(); // "16-MAY-2026"
    const [day, month, year] = datePart.split("-"); // ["16","MAY","2026"]

    // build a parseable string: "16 MAY 2026 6:00 PM"
    const combined = `${day} ${month} ${year} ${startTime}`;
    const parsed = new Date(combined);

    return isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

module.exports = router;
