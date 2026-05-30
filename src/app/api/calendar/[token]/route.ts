export async function GET(req: Request) {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//moviecal//EN',
    'END:VCALENDAR'
  ].join('\r\n');

  return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8' } });
}
