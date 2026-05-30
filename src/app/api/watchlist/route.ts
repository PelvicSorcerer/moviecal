import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  return NextResponse.json({ ok: true, message: 'watchlist GET placeholder' });
}

export async function POST(req: Request) {
  return NextResponse.json({ ok: true, message: 'watchlist POST placeholder' });
}

export async function DELETE(req: Request) {
  return NextResponse.json({ ok: true, message: 'watchlist DELETE placeholder' });
}
