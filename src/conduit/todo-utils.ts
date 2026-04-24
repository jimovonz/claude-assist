/**
 * Natural language parsing for todos
 * Extracts time hints, location hints, and core text from todo input
 */

export interface ParsedTodo {
  text: string;
  reminderTime?: number;
  locationHint?: string;
}

const LOCATION_PATTERNS = [
  /(?:at|@)\s+(?:the\s+)?(\w+(?:\s+\w+)?(?:\s+store)?)/i,
  /(?:in|at)\s+(\w+(?:\s+\w+)?)/i,
];

const TIME_PATTERNS = [
  // "in 2 hours", "in 30 minutes"
  /in\s+(\d+)\s+(hours?|minutes?|days?)/i,
  // "3pm", "3:30pm", "15:30"
  /(\d{1,2}):?(\d{2})?\s*(?:am|pm)?/i,
  // "at 3", "at 3pm"
  /at\s+(\d{1,2})\s*(?:am|pm)?/i,
  // "today at 2pm"
  /today\s+at\s+(\d{1,2}):?(\d{2})?\s*(?:am|pm)?/i,
  // "tomorrow at 2pm"
  /tomorrow\s+at\s+(\d{1,2}):?(\d{2})?\s*(?:am|pm)?/i,
  // "monday", "friday", etc (weekday names)
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  // "next week", "next monday"
  /next\s+(week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
];

const REPEAT_PATTERNS = [
  // "every monday", "daily", "weekly"
  /every\s+(day|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
  /\b(daily|weekly|monthly)\b/i,
];

export function parseTodoInput(input: string): ParsedTodo {
  const text = input.trim();
  let reminderTime: number | undefined;
  let locationHint: string | undefined;

  // Extract location hint
  for (const pattern of LOCATION_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      locationHint = match[1].toLowerCase();
      break;
    }
  }

  // Extract time hint with support for relative dates and durations
  const now = new Date();

  // Check for "in X hours/minutes/days" pattern
  const durationMatch = text.match(/in\s+(\d+)\s+(hours?|minutes?|days?)/i);
  if (durationMatch) {
    const amount = parseInt(durationMatch[1]!);
    const unit = durationMatch[2]!.toLowerCase();
    const reminderDate = new Date(now);

    if (unit.startsWith('hour')) {
      reminderDate.setHours(reminderDate.getHours() + amount);
    } else if (unit.startsWith('minute')) {
      reminderDate.setMinutes(reminderDate.getMinutes() + amount);
    } else if (unit.startsWith('day')) {
      reminderDate.setDate(reminderDate.getDate() + amount);
    }

    reminderTime = reminderDate.getTime();
  }

  // Check for explicit time patterns (HH:MM or H am/pm)
  if (!reminderTime) {
    const timeMatch = text.match(/(\d{1,2}):?(\d{2})?\s*(?:am|pm)?/i);
    if (timeMatch) {
      const hour = parseInt(timeMatch[1]!);
      const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;

      const reminderDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);

      // If the time is in the past, schedule for tomorrow
      if (reminderDate < now) {
        reminderDate.setDate(reminderDate.getDate() + 1);
      }

      reminderTime = reminderDate.getTime();
    }
  }

  // Check for weekday names (Monday, Friday, etc.)
  if (!reminderTime) {
    const weekdayMatch = text.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (weekdayMatch) {
      const dayName = weekdayMatch[1]!.toLowerCase();
      const dayMap: Record<string, number> = {
        sunday: 0,
        monday: 1,
        tuesday: 2,
        wednesday: 3,
        thursday: 4,
        friday: 5,
        saturday: 6,
      };
      const targetDay = dayMap[dayName]!;
      const currentDay = now.getDay();

      const reminderDate = new Date(now);
      let daysAhead = targetDay - currentDay;

      // If the day is today or in the past, schedule for next week
      if (daysAhead <= 0) {
        daysAhead += 7;
      }

      reminderDate.setDate(reminderDate.getDate() + daysAhead);
      reminderDate.setHours(9, 0, 0, 0); // Default to 9am

      reminderTime = reminderDate.getTime();
    }
  }

  return {
    text,
    reminderTime,
    locationHint,
  };
}

/**
 * Format a todo for display
 */
export function formatTodoDisplay(todo: { id: string; text: string; done: boolean; reminderTime?: number; locationHint?: string }): string {
  const status = todo.done ? "✓" : "○";
  const time = todo.reminderTime ? ` @ ${new Date(todo.reminderTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  const location = todo.locationHint ? ` (${todo.locationHint})` : "";
  return `${status} [${todo.id}] ${todo.text}${time}${location}`;
}
