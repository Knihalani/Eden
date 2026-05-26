import { NextResponse } from "next/server";
import { api } from "@/lib/api";

interface RouteParams {
  params: Promise<{ job_id: string }>;
}

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { job_id } = await params;
    const data = await api.cancelJob(job_id);
    return NextResponse.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to cancel job";
    return NextResponse.json({ detail: message }, { status: 500 });
  }
}