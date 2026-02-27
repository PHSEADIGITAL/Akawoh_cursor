import { NextRequest, NextResponse } from "next/server";
import { markMissedContribution } from "@/lib/mvp-service";

const authorized = (req: NextRequest): boolean => {
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${process.env.CRON_SECRET}`;
};

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production" && !authorized(req)) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await markMissedContribution();
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "Unexpected error" },
      { status: 500 }
    );
  }
}
