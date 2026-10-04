// =====================================================================
// ดึงสถานะเขื่อนจาก API สาธารณะของกรมชลประทาน (RID) แล้วบันทึกลงตาราง
// public.dam_readings ใน Supabase — รันโดย GitHub Actions ตามตารางเวลา
// (ดู .github/workflows/update-dam-status.yml)
//
// เหตุผลที่ต้องรันจาก GitHub แทนที่จะให้ Supabase Edge Function ดึงเอง:
// เว็บ RID บล็อกการเชื่อมต่อจาก IP ของผู้ให้บริการ cloud บางราย (ยืนยันจาก
// Supabase Edge Function Logs: "TypeError: error sending request" ซึ่งเป็น
// error ระดับเครือข่าย) เซิร์ฟเวอร์ของ GitHub Actions ไม่โดนบล็อกแบบนั้น
//
// ต้องการ 2 environment variables (ตั้งเป็น GitHub Secrets):
//   SUPABASE_URL                 เช่น https://adonbpupbdvxsvwtuzhy.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    กุญแจลับ (ห้ามเผยแพร่ ใช้ได้เฉพาะใน Secrets เท่านั้น)
// =====================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("ขาด environment variable: SUPABASE_URL หรือ SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const RID_BASE = "https://app.rid.go.th/reservoir/api/dam/public";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function bangkokDateMinus(daysAgo) {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000); // UTC -> เวลาไทย
  now.setUTCDate(now.getUTCDate() - daysAgo);
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function fetchRidDamsForDate(dateStr) {
  const res = await fetch(`${RID_BASE}/${dateStr}`, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const regions = raw?.data || [];
  const dams = [];
  for (const r of regions) {
    const list = r?.dam || r?.dams || [];
    for (const d of list) dams.push(d);
  }
  return { dams, date: raw?.date ?? dateStr };
}

async function supabaseRest(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Supabase REST ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
async function main() {
  // 1) อ่านรายชื่อเขื่อนที่ผู้ดูแลตั้งค่าไว้
  const tracked = await supabaseRest("dam_stations?select=rid_dam_id,name");
  if (!tracked || tracked.length === 0) {
    console.log("ยังไม่มีเขื่อนที่ตั้งค่าไว้ใน dam_stations — ไม่มีอะไรให้ดึง");
    return;
  }
  const trackedIds = new Set(tracked.map((t) => t.rid_dam_id));
  console.log(`ติดตาม ${trackedIds.size} เขื่อน:`, [...trackedIds].join(", "));

  // 2) ลองย้อนหลังสูงสุด 3 วัน หาวันแรกที่มีข้อมูลจริงของเขื่อนที่ติดตามอยู่
  let dams = [];
  let usedDate = null;
  let lastErr = null;
  for (let i = 0; i <= 3; i++) {
    const dateStr = bangkokDateMinus(i);
    try {
      const { dams: list, date } = await fetchRidDamsForDate(dateStr);
      const hasData = list.some((d) => trackedIds.has(d.id) && d.volume != null);
      console.log(`${dateStr}: ดึงได้ ${list.length} เขื่อนทั้งหมด, มีข้อมูลที่ติดตามอยู่หรือไม่ = ${hasData}`);
      if (hasData || i === 3) {
        dams = list;
        usedDate = date;
        break;
      }
    } catch (e) {
      lastErr = e;
      console.error(`ดึงข้อมูลวันที่ ${dateStr} ไม่สำเร็จ:`, e.message);
    }
  }

  if (dams.length === 0) {
    console.error("ดึงข้อมูลจาก RID ไม่สำเร็จเลยทั้ง 4 วันที่ลอง");
    if (lastErr) console.error("error ล่าสุด:", lastErr);
    process.exit(1); // ให้ GitHub Actions แสดงว่ารอบนี้ล้มเหลว (ขึ้นกากบาทแดงใน Actions tab)
  }

  // 3) เตรียมแถวสำหรับ upsert เฉพาะเขื่อนที่ติดตามอยู่และมีข้อมูลจริง
  const fetchedAt = new Date().toISOString();
  const rows = dams
    .filter((d) => trackedIds.has(d.id) && d.volume != null)
    .map((d) => ({
      rid_dam_id: d.id,
      capacity: d.capacity ?? null,
      volume: d.volume ?? null,
      percent_storage: d.percent_storage ?? null,
      inflow: d.inflow ?? null,
      outflow: d.outflow ?? null,
      data_date: usedDate,
      fetched_at: fetchedAt,
    }));

  if (rows.length === 0) {
    console.error("ไม่มีเขื่อนที่ติดตามอยู่ปรากฏในข้อมูลที่ดึงมาได้เลย (เช็ครหัส rid_dam_id ในหน้าแอดมินอีกครั้ง)");
    process.exit(1);
  }

  console.log(`จะบันทึก ${rows.length} แถว (วันที่ข้อมูล: ${usedDate})`);

  // 4) upsert ลง dam_readings (merge-duplicates = upsert ตาม primary key rid_dam_id)
  await supabaseRest("dam_readings", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });

  console.log("บันทึกสำเร็จ ✅");
}

main().catch((e) => {
  console.error("เกิดข้อผิดพลาดที่ไม่คาดคิด:", e);
  process.exit(1);
});
