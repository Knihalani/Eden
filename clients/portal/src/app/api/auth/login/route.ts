import { NextResponse } from "next/server";
import { api } from "@/lib/api";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const data = await api.login(body);
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Login failed";
    return NextResponse.json({ detail: message }, { status: 401 });
  }
}