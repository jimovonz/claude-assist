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
  /(?:in\s+)?(\w+(?:\s+\w+)?)/i,
];

const TIME_PATTERNS = [
  // "3pm", "3:30pm", "15:30"
  /(\d{1,2}):?(\d{2})?\s*(?:am|pm)?/i,
  // "at 3", "at 3pm"
  /at\s+(\d{1,2})\s*(?:am|pm)?/i,
  // "today at 2pm"
  /today\s+at\s+(\d{1,2}):?(\d{2})?\s*(?:am|pm)?/i,
  // "tomorrow at 2pm"
  /tomorrow\s+at\s+(\d{1,2}):?(\d{2})?\s*(?:am|pm)?/i,
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

  // Extract time hint (simplified - just look for time patterns)
  const timeMatch = text.match(/(\d{1,2}):?(\d{2})?\s*(?:am|pm)/i);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]);
    const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;

    // Create a reminder time for today
    const now = new Date();
    const reminderDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);

    // If the time is in the past, schedule for tomorrow
    if (reminderDate < now) {
      reminderDate.setDate(reminderDate.getDate() + 1);
    }

    reminderTime = reminderDate.getTime();
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
export function formatTodoDisplay(id: string, text: string, reminderTime?: number, locationHint?: string, done = false): string {
  const status = done ? "✓" : "○";
  const time = reminderTime ? ` @ ${new Date(reminderTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  const location = locationHint ? ` (${locationHint})` : "";
  return `${status} [${id}] ${text}${time}${location}`;
}
