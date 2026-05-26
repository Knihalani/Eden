import { NextResponse } from "next/server";
import { api } from "@/lib/api";

export async function GET() {
  try {
    const data = await api.getMe();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Not authenticated";
    return NextResponse.json({ detail: message }, { status: 401 });
  }
}