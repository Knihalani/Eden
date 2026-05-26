import { NextResponse } from "next/server";
import { api } from "@/lib/api";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const data = await api.signup(body);
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Signup failed";
    return NextResponse.json({ detail: message }, { status: 409 });
  }
}