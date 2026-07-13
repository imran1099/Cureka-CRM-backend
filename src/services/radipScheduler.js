import { db } from "../db/connection.js";
import { executeStandardReport, exportReport } from "./radipService.js";

/**
 * RADIP Scheduler Interface
 * 
 * V1 Implementation: Lightweight in-memory Polling
 * Production Upgrade Path: Swap `initScheduler` with BullMQ + Redis workers.
 */

let scheduleInterval = null;

// The abstracted task runner
async function processScheduledReports() {
  try {
    // In V1, we'll simply scan for any active schedules.
    // In production, the frequency string ('daily', 'weekly') would be parsed as a Cron expression by BullMQ.
    const schedules = await db.all("SELECT * FROM radip_report_schedules");
    
    // For demonstration of the abstract interface, we won't execute them on every tick,
    // but rather this function represents the entry point for the worker processing a job.
    console.log(`[RADIP Scheduler] Heartbeat. Monitoring ${schedules.length} active schedules.`);
    
    /* 
    Example Job Execution Logic (simulated):
    for (const job of schedules) {
      if (shouldRunNow(job.frequency)) {
        const reportConfig = await db.get("SELECT * FROM radip_reports WHERE id = ?", job.report_id);
        const data = await executeStandardReport(job.report_id, {});
        const csv = await exportReport(data, job.format);
        await sendEmail(job.recipients, csv);
      }
    }
    */
  } catch (err) {
    console.error("[RADIP Scheduler] Error processing schedules:", err);
  }
}

export function initScheduler() {
  if (scheduleInterval) clearInterval(scheduleInterval);
  
  console.log("[RADIP Scheduler] Initializing in-memory scheduling engine (V1).");
  console.log("[RADIP Scheduler] Upgrade Path: Replace with BullMQ for production scaling.");
  
  // Run every hour in a real app, running every 60 seconds here for demo visibility
  scheduleInterval = setInterval(processScheduledReports, 60000);
}

export async function addSchedule(reportId, frequency, format, recipients, createdBy) {
  const id = `sched_${Date.now()}`;
  await db.run(
    "INSERT INTO radip_report_schedules (id, report_id, frequency, format, recipients, created_by) VALUES (?, ?, ?, ?, ?, ?)",
    [id, reportId, frequency, format, JSON.stringify(recipients), createdBy]
  );
  return id;
}

export async function removeSchedule(scheduleId) {
  await db.run("DELETE FROM radip_report_schedules WHERE id = ?", scheduleId);
}
