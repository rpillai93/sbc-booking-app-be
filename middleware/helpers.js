module.exports = {
  isAdmin: (req) => req.user.role === "admin",
  formatDateForServer: (dateStr) => {
    const date = new Date(dateStr + "T00:00:00");

    const weekday = date.toLocaleDateString("en-US", {
      weekday: "long",
    });

    const day = String(date.getDate()).padStart(2, "0");

    const month = date
      .toLocaleDateString("en-US", { month: "short" })
      .toUpperCase();

    const year = date.getFullYear();

    return `${weekday.toLocaleUpperCase()}, ${day}-${month}-${year}`;
  },
  rebalanceSlot: (slot, newPlayerCount) => {
    const combined = [...slot.players, ...slot.waitList]; // preserve order
    const players = combined.slice(0, newPlayerCount);
    const waitList = combined.slice(newPlayerCount, 10); // cap total at 10
    return { players, waitList };
  },
};
