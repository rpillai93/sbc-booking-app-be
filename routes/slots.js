const router = require("express").Router();
const Slot = require("../models/Slot");
const User = require("../models/User");
const auth = require("../middleware/auth");
const { v4: uuidv4 } = require("uuid");
const {
  isAdmin,
  formatDateForServer,
  rebalanceSlot,
} = require("../middleware/helpers");
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
    const dateFormatted = formatDateForServer(date);

    const existing = await Slot.findOne({ date: dateFormatted, time }).select(
      "groupId numberOfCourts",
    );
    const groupId = existing?.groupId ?? uuidv4();
    const totalCourts = existing ? existing.numberOfCourts + count : count;
    const playerCount = totalCourts <= 2 ? 6 : 7;
    const waitListCount = 10 - playerCount;
    const created = [];

    for (let i = 0; i < count; i++) {
      const slot = await Slot.create({
        date: dateFormatted,
        time,
        groupId,
        numberOfCourts: count,
        players: Array(playerCount).fill({}),
        waitList: Array(waitListCount).fill({}),
      });
      created.push(slot);
    }

    if (existing) {
      const existingSlots = await Slot.find({
        groupId,
        _id: { $nin: created.map((s) => s._id) },
      });

      await Promise.all(
        existingSlots.map((slot) => {
          const { players, waitList } = rebalanceSlot(slot, playerCount);
          return Slot.findByIdAndUpdate(slot._id, {
            numberOfCourts: totalCourts,
            players,
            waitList,
          });
        }),
      );
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
    const slot = await Slot.findById(req.params.id);
    if (!slot) return res.status(404).json({ message: "Slot not found" });

    const { groupId } = slot;
    await Slot.findByIdAndDelete(req.params.id);

    const remainingSlots = await Slot.find({
      groupId,
      _id: { $ne: req.params.id },
    });

    if (remainingSlots.length > 0) {
      const totalCourts = remainingSlots.length;
      const playerCount = totalCourts <= 2 ? 6 : 7;

      await Promise.all(
        remainingSlots.map((s) => {
          const { players, waitList } = rebalanceSlot(s, playerCount);
          return Slot.findByIdAndUpdate(s._id, {
            numberOfCourts: totalCourts,
            players,
            waitList,
          });
        }),
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch("/:id/player", auth, async (req, res) => {
  try {
    const { playerIndex, name, lastUpdatedAt } = req.body;
    const lastUpdatedIdentifier = req.user.identifier;
    // fetch acting user's first name for the ownerName audit field
    const actingUser = await User.findById(req.user.id).select("firstName");
    const lastUpdatedName = actingUser.firstName;

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

    const PLAYER_COUNT = slot.numberOfCourts <= 2 ? 6 : 7;
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
      if (
        target?.ownerIdentifier &&
        target.ownerIdentifier !== lastUpdatedIdentifier
      ) {
        return res.status(403).json({
          message:
            "You can only modify a booking created by you. Speak to an admin to modify another booking.",
        });
      }
    }

    // ── WRITE ────────────────────────────────────────────────────────────────
    const isRemovingPlayer = (!name || name.trim() === "") && !isWaitlist;

    if (isRemovingPlayer) {
      let promoted = {
        name: "",
        ownerIdentifier: "",
        ownerName: "",
        lastUpdatedIdentifier: "",
        timeStamp: "",
        payment: false,
        playerAmt: 0,
      };
      const index = slot.waitList.findIndex((p) => p.name?.trim());
      if (index !== -1) {
        promoted = slot.waitList.splice(index, 1)[0];
        slot.waitList.push({
          name: "",
          ownerIdentifier: "",
          ownerName: "",
          lastUpdatedIdentifier: "",
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
          ownerIdentifier: "",
          ownerName: "",
          lastUpdatedIdentifier: "",
          timeStamp: "",
          payment: false,
          playerAmt: 0,
        });
      } else if (!slot.waitList[wlIndex]?.name) {
        // filling an empty waitlist spot
        slot.waitList[wlIndex] = {
          name,
          ownerIdentifier: lastUpdatedIdentifier,
          ownerName: lastUpdatedName,
          lastUpdatedIdentifier,
          timeStamp: ts,
          payment: false,
          playerAmt: 0,
        };
      } else {
        // updating own existing waitlist entry or admin modifying on behalf of someone
        const isAdminRequest =
          slot.waitList[wlIndex].ownerIdentifier !== "" &&
          slot.waitList[wlIndex].ownerIdentifier !== lastUpdatedIdentifier;
        slot.waitList[wlIndex] = {
          name,
          ownerIdentifier: isAdminRequest
            ? slot.waitList[wlIndex].ownerIdentifier
            : lastUpdatedIdentifier,
          ownerName: isAdminRequest
            ? slot.waitList[wlIndex].ownerName
            : lastUpdatedName,
          lastUpdatedIdentifier,
          timeStamp: ts,
          payment: slot.waitList[wlIndex].payment,
          playerAmt: slot.waitList[wlIndex].playerAmt,
        };
      }
    } else {
      // updating own existing player entry or admin modifying on behalf of someone
      const isAdminRequest =
        slot.players[playerIndex].ownerIdentifier !== "" &&
        slot.players[playerIndex].ownerIdentifier !== lastUpdatedIdentifier;
      slot.players[playerIndex] = {
        name,
        ownerIdentifier: isAdminRequest
          ? slot.players[playerIndex].ownerIdentifier
          : lastUpdatedIdentifier,
        ownerName: isAdminRequest
          ? slot.players[playerIndex].ownerName
          : lastUpdatedName,
        lastUpdatedIdentifier,
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
router.patch("/:id/amount", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });
  try {
    const { totalAmt = 0, players = [], waitList = [] } = req.body;

    const slot = await Slot.findById(req.params.id);
    if (!slot) return res.status(404).json({ message: "Slot not found" });

    const playerMap = new Map(players.map((p) => [String(p._id), p.playerAmt]));
    const waitListMap = new Map(
      waitList.map((p) => [String(p._id), p.playerAmt]),
    );

    const balanceDeltaMap = new Map(); // Map<ownerIdentifier, number>

    const applyDelta = (identifier, delta) => {
      if (!identifier) return;
      const current = balanceDeltaMap.get(identifier) ?? 0;
      balanceDeltaMap.set(identifier, current + delta);
    };

    let playersModified = false;
    let waitListModified = false;

    // ── Main players ──────────────────────────────────────────────────────────
    slot.players.forEach((sp) => {
      const newAmt = playerMap.get(String(sp._id));
      if (newAmt === undefined) return;

      // oldAmt is always read from the current stored playerAmt so that
      // successive edits compute the correct incremental delta each time.
      // On first publish slotAmountPublished is false so oldAmt is 0.
      const oldAmt = slot.slotAmountPublished ? (sp.playerAmt ?? 0) : 0;
      const delta = newAmt - oldAmt;

      // Only update playerAmt if the player hasn't paid yet.
      // For paid players we still track the delta so balancePayments
      // reflects any adjustment on top of what they already paid.
      if (!sp.payment) {
        sp.playerAmt = newAmt;
        playersModified = true;
      }

      // Always increment balancePayments by the delta regardless of payment
      // status. For paid players this correctly tracks adjustments on top of
      // what they already paid.
      if (delta !== 0) applyDelta(sp.ownerIdentifier, delta);
    });

    // ── Wait-list players ─────────────────────────────────────────────────────
    slot.waitList.forEach((swp) => {
      const newAmt = waitListMap.get(String(swp._id));
      if (newAmt === undefined) return;

      const oldAmt = slot.slotAmountPublished ? (swp.playerAmt ?? 0) : 0;
      const delta = newAmt - oldAmt;

      if (!swp.payment) {
        swp.playerAmt = newAmt;
        waitListModified = true;
      }

      if (delta !== 0) applyDelta(swp.ownerIdentifier, delta);
    });

    slot.slotTotalAmount = totalAmt;

    if (!slot.slotAmountPublished) slot.slotAmountPublished = true;
    if (playersModified) slot.markModified("players");
    if (waitListModified) slot.markModified("waitList");

    await slot.save();

    // ── Apply balance deltas to User records ──────────────────────────────────
    // ownerIdentifier is an email (contains "@") or a phone number.
    // We match against User.email or User.phone accordingly.
    //
    if (balanceDeltaMap.size > 0) {
      const updatePromises = [];

      for (const [identifier, delta] of balanceDeltaMap.entries()) {
        if (delta === 0) continue;

        const isEmail = identifier.includes("@");
        const query = isEmail ? { email: identifier } : { phone: identifier };

        updatePromises.push(
          User.findOneAndUpdate(
            query,
            { $inc: { balancePayments: delta } },
            { returnDocument: "after" },
          ),
        );
      }

      await Promise.all(updatePromises);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH update payment status
// Payment is one-way: false → true only. Players are blocked from paying twice
// on the client, so this route is called exactly once per player per slot.
router.patch("/:id/payment", auth, async (req, res) => {
  try {
    const { playerIndex, lastUpdatedAt } = req.body;
    const slot = await Slot.findById(req.params.id);

    // ── GUARD 1: slot existence ───────────────────────────────────────────────
    if (!slot) return res.status(404).json({ message: "Slot not found" });

    // ── GUARD 2: timestamp check ──────────────────────────────────────────────
    // Reject if the slot was modified by anyone since this user last loaded
    // the page, to prevent stale overwrites.
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

    const PLAYER_COUNT = slot.numberOfCourts <= 2 ? 6 : 7;
    const isWaitlist = playerIndex >= PLAYER_COUNT;

    // ── GUARD 3: non-admins can only update their own payment ─────────────────
    if (!isAdmin(req)) {
      const target = isWaitlist
        ? slot.waitList[playerIndex - PLAYER_COUNT]
        : slot.players[playerIndex];
      if (target?.ownerIdentifier && target.ownerIdentifier !== identifier) {
        return res
          .status(403)
          .json({ message: "You can only update your own payment" });
      }
    }

    // ── Step 1: resolve the target player record ──────────────────────────────
    const target = isWaitlist
      ? slot.waitList[playerIndex - PLAYER_COUNT]
      : slot.players[playerIndex];

    // ── GUARD 4: prevent double-payment server-side ───────────────────────────
    if (target?.payment === true) {
      return res
        .status(409)
        .json({ message: "Payment has already been made for this slot." });
    }

    // ── Step 2: set payment flag to true on the slot ──────────────────────────
    if (isWaitlist) {
      slot.waitList[playerIndex - PLAYER_COUNT].payment = true;
      slot.markModified("waitList");
    } else {
      slot.players[playerIndex].payment = true;
      slot.markModified("players");
    }

    await slot.save();

    // ── Step 3: decrement User.balancePayments by playerAmt ───────────────────
    //
    // Payment is always false → true, so we always decrease the user's
    // outstanding balance by the player's owed amount.
    //
    // ownerIdentifier is an email (contains "@") or a phone number.
    // We match against User.email or User.phone accordingly.
    //
    const ownerIdentifier = target?.ownerIdentifier;
    const playerAmt = target?.playerAmt ?? 0;

    if (ownerIdentifier && playerAmt !== 0) {
      const isEmail = ownerIdentifier.includes("@");
      const query = isEmail
        ? { email: ownerIdentifier }
        : { phone: ownerIdentifier };

      await User.findOneAndUpdate(
        query,
        { $inc: { balancePayments: -playerAmt } },
        { returnDocument: "after" },
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH lock/unlock — admin only
router.patch("/:id/lock", auth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ message: "Unauthorized" });
  try {
    const isLocked = req.body.isLocked;
    const slot = await Slot.findById(req.params.id);
    if (!slot) return res.status(404).json({ message: "Slot not found" });

    // Set slotLocked on the slot itself
    slot.slotLocked = isLocked;

    // Update only players with a real name
    slot.players.forEach((p) => {
      if (p.name && p.name.trim() !== "" && p.name !== "Available") {
        p.playerLocked = isLocked;
      }
    });

    slot.waitList.forEach((p) => {
      if (p.name && p.name.trim() !== "" && p.name !== "Waitlist") {
        p.playerLocked = isLocked;
      }
    });

    await slot.save();
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
        slot.slotLocked = true;

        slot.players.forEach((p) => {
          if (p.name && p.name.trim() !== "" && p.name !== "Available") {
            p.playerLocked = true;
          }
        });

        slot.waitList.forEach((p) => {
          if (p.name && p.name.trim() !== "" && p.name !== "Waitlist") {
            p.playerLocked = true;
          }
        });

        await slot.save();
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
