import { NextRequest, NextResponse } from "next/server";
import { runOwnerRevenueSettlementJobs } from "@/lib/mvp-service";

const authorized = (req: NextRequest): boolean => {
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${process.env.CRON_SECRET}`;
};

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production" && !authorized(req)) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const result = await runOwnerRevenueSettlementJobs();
  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
