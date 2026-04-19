const fs = require('fs');
const path = require('path');

function safeParseJson(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function asDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readTimingEvents(filePath, tailLimit = 5000) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines
    .slice(Math.max(0, lines.length - tailLimit))
    .map(safeParseJson)
    .filter(Boolean);
}

function buildIntervals(events, stages = []) {
  return events
    .filter((event) => stages.includes(String(event.stage || '').trim()))
    .map((event) => {
      const end = asDate(event.recordedAt);
      const durationMs = Math.max(0, Number(event.durationMs || 0) || 0);
      if (!end) return null;
      const start = new Date(end.getTime() - durationMs);
      return {
        stage: String(event.stage || '').trim(),
        messageId: String(event.messageId || '').trim(),
        userId: String(event.userId || '').trim(),
        groupId: String(event.groupId || '').trim(),
        chatType: String(event.chatType || '').trim(),
        start,
        end,
        durationMs
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

function computeOverlapStats(intervals = []) {
  const overlaps = [];
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      const a = intervals[i];
      const b = intervals[j];
      if (b.start >= a.end) break;
      const overlapMs = Math.max(0, Math.min(a.end.getTime(), b.end.getTime()) - Math.max(a.start.getTime(), b.start.getTime()));
      if (overlapMs > 0) {
        overlaps.push({
          overlapMs,
          a,
          b
        });
      }
    }
  }
  return overlaps;
}

function summarizeForeground(events = []) {
  const foregroundEvents = events.filter((event) => String(event.stage || '').trim() === 'inbound_lock_acquired');
  const waits = foregroundEvents.map((event) => Number(event.foreground_wait_ms || 0) || 0);
  const peakTotal = foregroundEvents.reduce((max, event) => Math.max(max, Number(event.foreground_active_total || 0) || 0), 0);
  const avgWaitMs = waits.length ? Math.round(waits.reduce((sum, value) => sum + value, 0) / waits.length) : 0;
  return {
    count: foregroundEvents.length,
    peakTotal,
    avgWaitMs
  };
}

function formatInterval(interval) {
  return `${interval.chatType || 'unknown'} ${interval.stage} msg=${interval.messageId || '-'} user=${interval.userId || '-'} ${interval.start.toISOString()} -> ${interval.end.toISOString()} (${interval.durationMs}ms)`;
}

function main() {
  const filePath = path.join(process.cwd(), 'data', 'inbound_timing.jsonl');
  const events = readTimingEvents(filePath, 5000);
  const routePlannerReplyIntervals = buildIntervals(events, [
    'route_resolver_done',
    'direct_chat_planner_done',
    'reply_send_success',
    'reply_send_failure'
  ]);
  const overlaps = computeOverlapStats(routePlannerReplyIntervals);
  const foreground = summarizeForeground(events);

  console.log(`timing_file=${filePath}`);
  console.log(`route_planner_reply_intervals=${routePlannerReplyIntervals.length}`);
  console.log(`foreground_count=${foreground.count}`);
  console.log(`foreground_peak_total=${foreground.peakTotal}`);
  console.log(`foreground_avg_wait_ms=${foreground.avgWaitMs}`);
  console.log(`interval_overlaps=${overlaps.length}`);

  console.log('\nrecent_intervals:');
  for (const interval of routePlannerReplyIntervals.slice(-20)) {
    console.log(formatInterval(interval));
  }

  console.log('\nrecent_overlaps:');
  if (overlaps.length === 0) {
    console.log('none');
  } else {
    for (const item of overlaps.slice(-20)) {
      console.log(`overlap=${item.overlapMs}ms`);
      console.log(`  A ${formatInterval(item.a)}`);
      console.log(`  B ${formatInterval(item.b)}`);
    }
  }
}

main();
