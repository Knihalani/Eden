import { NextResponse } from "next/server";
import { api } from "@/lib/api";

export async function POST() {
  try {
    const data = await api.logout();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Logout failed";
    return NextResponse.json({ detail: message }, { status: 500 });
  }
}