export async function POST(req: Request) {
  return new Response(JSON.stringify({ ok: true, message: 'scheduled refresh placeholder' }), { headers: { 'Content-Type': 'application/json' } });
}
