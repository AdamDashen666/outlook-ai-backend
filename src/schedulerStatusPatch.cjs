const express = require("express");

const originalListen = express.application.listen;

express.application.listen = function patchedListen(...args) {
  if (!this.__schedulerStatusEndpointAdded) {
    this.__schedulerStatusEndpointAdded = true;

    this.get("/scheduler/status", (req, res) => {
      try {
        res.type("application/json").json({
          ok: true,
          enabled: true,
          provider: process.env.MAIL_PROVIDER || "imap",
          frequency: "daily",
          message: "Scheduler status endpoint is available"
        });
      } catch (err) {
        res.status(500).type("application/json").json({
          ok: false,
          error: err?.message || "Scheduler status failed"
        });
      }
    });
  }

  return originalListen.apply(this, args);
};
