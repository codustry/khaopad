/**
 * Seed the demo storefront with a believable Thai homeware / lifestyle
 * catalogue — products, variants, collections, reviews, orders, and
 * discounts.
 *
 * The CMS seed (seed.ts) only fills articles/taxonomy, so the demo shop
 * rendered "No products yet" while every commerce feature shipped. This
 * fills in enough catalogue and order history that browse, facets, Thai
 * search, variant pickers, collections, reviews, the admin order list,
 * and the finance/time-series reports are all explorable.
 *
 * Usage:
 *   pnpm db:seed:shop                                  # local D1
 *   D1_DB_NAME=khaopad-example-db pnpm db:seed:shop -- --remote
 *
 * Idempotent: every row uses INSERT OR REPLACE on a stable `seed_*` id,
 * so re-running after a nightly reset restores the same fixture. Join
 * tables and the FTS index are DELETEd for seed ids first, since they
 * have no single-column identity to REPLACE on.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const remote = process.argv.includes("--remote");
const target = remote ? "--remote" : "--local";
const dbName = process.env.D1_DB_NAME ?? "khaopad-db";
const now = new Date().toISOString();

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const nul = (v: string | number | null | undefined) =>
  v === null || v === undefined
    ? "NULL"
    : typeof v === "number"
      ? `${v}`
      : q(v);

/** ISO timestamp N days before now — spreads orders over a reporting window. */
const daysAgo = (n: number, hour = 10) => {
  const d = new Date(Date.now() - n * 86_400_000);
  d.setUTCHours(hour, (n * 7) % 60, 0, 0);
  return d.toISOString();
};

// ─── Catalogue ──────────────────────────────────────────────

type SeedVariant = {
  key: string; // suffix -> variant id `${product.id}_${key}`
  sku: string;
  title: string; // cached title, e.g. "Indigo / M"
  priceSatang: number;
  compareAtSatang?: number;
  weightGrams?: number;
  onHand: number;
  /** option value keys this variant is built from (option axis order) */
  optionValues?: string[];
  continueSelling?: boolean;
  costSatang?: number;
};

type SeedOption = {
  name: string;
  values: { key: string; value: string; swatchHex?: string }[];
};

type SeedProduct = {
  id: string;
  slug: string;
  vendor: string;
  productType: string;
  tags: string[];
  titleEn: string;
  titleTh: string;
  descEn: string;
  descTh: string;
  options?: SeedOption[];
  variants: SeedVariant[];
};

const V = (
  key: string,
  sku: string,
  title: string,
  priceSatang: number,
  onHand: number,
  extra: Partial<SeedVariant> = {},
): SeedVariant => ({ key, sku, title, priceSatang, onHand, ...extra });

const products: SeedProduct[] = [
  // ── Khao Goods · Bags & carry ──────────────────────────────
  {
    id: "seed_prod_tote",
    slug: "canvas-tote-bag",
    vendor: "Khao Goods",
    productType: "Bags",
    tags: ["everyday", "cotton", "carry"],
    titleEn: "Canvas Tote Bag",
    titleTh: "กระเป๋าผ้าแคนวาส",
    descEn:
      "A sturdy 12oz cotton canvas tote with reinforced handles. Roomy enough for a laptop, a market run, or both.",
    descTh:
      "กระเป๋าผ้าแคนวาสคอตตอน 12 ออนซ์ หูจับเสริมความแข็งแรง ใส่โน้ตบุ๊กหรือของจากตลาดได้สบาย",
    options: [
      {
        name: "Colour",
        values: [
          { key: "natural", value: "Natural", swatchHex: "#e7ddc8" },
          { key: "indigo", value: "Indigo", swatchHex: "#2f3f6b" },
          { key: "charcoal", value: "Charcoal", swatchHex: "#3b3b3b" },
        ],
      },
    ],
    variants: [
      V("natural", "TOTE-CANVAS-NAT", "Natural", 45000, 42, {
        compareAtSatang: 59000,
        optionValues: ["natural"],
        weightGrams: 380,
        costSatang: 21000,
      }),
      V("indigo", "TOTE-CANVAS-IND", "Indigo", 45000, 18, {
        compareAtSatang: 59000,
        optionValues: ["indigo"],
        weightGrams: 380,
        costSatang: 21000,
      }),
      V("charcoal", "TOTE-CANVAS-CHR", "Charcoal", 49000, 4, {
        optionValues: ["charcoal"],
        weightGrams: 390,
        costSatang: 23000,
      }),
    ],
  },
  {
    id: "seed_prod_daypack",
    slug: "waxed-canvas-daypack",
    vendor: "Khao Goods",
    productType: "Bags",
    tags: ["carry", "travel"],
    titleEn: "Waxed Canvas Daypack",
    titleTh: "เป้สะพายหลังผ้าแคนวาสเคลือบแว็กซ์",
    descEn:
      "Water-resistant waxed cotton with a padded 14-inch laptop sleeve and leather-tab closures. Ages into its own patina.",
    descTh:
      "ผ้าคอตตอนเคลือบแว็กซ์กันน้ำ มีช่องบุนวมสำหรับโน้ตบุ๊ก 14 นิ้ว ปิดด้วยหนังแท้ ยิ่งใช้ยิ่งสวยขึ้นตามกาลเวลา",
    variants: [
      V("v1", "PACK-WAXED", "Default", 189000, 11, {
        weightGrams: 1100,
        costSatang: 92000,
      }),
    ],
  },
  {
    id: "seed_prod_pouch",
    slug: "cotton-cable-pouch",
    vendor: "Khao Goods",
    productType: "Bags",
    tags: ["carry", "everyday", "cotton"],
    titleEn: "Cotton Cable Pouch",
    titleTh: "กระเป๋าใส่สายชาร์จผ้าคอตตอน",
    descEn:
      "A slim zip pouch for chargers, cables and a passport. Ripstop lining keeps the shape when it's empty.",
    descTh:
      "กระเป๋าซิปทรงบาง ใส่ที่ชาร์จ สายไฟ และพาสปอร์ต ซับในผ้าริปสต็อปช่วยคงทรงแม้ตอนไม่มีของ",
    variants: [
      V("v1", "POUCH-CABLE", "Default", 32000, 63, {
        weightGrams: 90,
        costSatang: 12000,
      }),
    ],
  },

  // ── Khao Goods · Apparel ───────────────────────────────────
  {
    id: "seed_prod_tee",
    slug: "everyday-cotton-tee",
    vendor: "Khao Goods",
    productType: "Apparel",
    tags: ["everyday", "cotton"],
    titleEn: "Everyday Cotton Tee",
    titleTh: "เสื้อยืดคอตตอนใส่ประจำวัน",
    descEn:
      "Soft combed cotton in a relaxed cut. Pre-shrunk, so it fits the same after the first wash.",
    descTh:
      "ผ้าคอตตอนหวีนุ่ม ทรงสบาย ผ่านการหดตัวมาแล้ว ซักครั้งแรกก็ยังใส่พอดี",
    options: [
      {
        name: "Size",
        values: [
          { key: "s", value: "S" },
          { key: "m", value: "M" },
          { key: "l", value: "L" },
          { key: "xl", value: "XL" },
        ],
      },
      {
        name: "Colour",
        values: [
          { key: "sand", value: "Sand", swatchHex: "#d9cbb3" },
          { key: "black", value: "Black", swatchHex: "#1c1c1c" },
        ],
      },
    ],
    variants: [
      V("s_sand", "TEE-COT-S-SAND", "S / Sand", 39000, 22, {
        optionValues: ["s", "sand"],
        weightGrams: 170,
        costSatang: 15000,
      }),
      V("m_sand", "TEE-COT-M-SAND", "M / Sand", 39000, 34, {
        optionValues: ["m", "sand"],
        weightGrams: 180,
        costSatang: 15000,
      }),
      V("l_sand", "TEE-COT-L-SAND", "L / Sand", 39000, 27, {
        optionValues: ["l", "sand"],
        weightGrams: 190,
        costSatang: 15000,
      }),
      V("xl_sand", "TEE-COT-XL-SAND", "XL / Sand", 42000, 0, {
        optionValues: ["xl", "sand"],
        weightGrams: 200,
        costSatang: 16000,
      }),
      V("s_black", "TEE-COT-S-BLK", "S / Black", 39000, 15, {
        optionValues: ["s", "black"],
        weightGrams: 170,
        costSatang: 15000,
      }),
      V("m_black", "TEE-COT-M-BLK", "M / Black", 39000, 41, {
        optionValues: ["m", "black"],
        weightGrams: 180,
        costSatang: 15000,
      }),
      V("l_black", "TEE-COT-L-BLK", "L / Black", 39000, 3, {
        optionValues: ["l", "black"],
        weightGrams: 190,
        costSatang: 15000,
      }),
      V("xl_black", "TEE-COT-XL-BLK", "XL / Black", 42000, 9, {
        optionValues: ["xl", "black"],
        weightGrams: 200,
        costSatang: 16000,
      }),
    ],
  },
  {
    id: "seed_prod_camp_shirt",
    slug: "linen-camp-shirt",
    vendor: "Khao Goods",
    productType: "Apparel",
    tags: ["linen", "summer"],
    titleEn: "Linen Camp Shirt",
    titleTh: "เสื้อเชิ้ตลินินคอปก",
    descEn:
      "An open-collar shirt in mid-weight washed linen. Breathes in Bangkok humidity and creases in a way that looks deliberate.",
    descTh:
      "เสื้อเชิ้ตคอปกเปิด ตัดจากผ้าลินินฟอกน้ำหนักกลาง ระบายอากาศดีรับความชื้นแบบกรุงเทพฯ ยับแบบสวยตั้งใจ",
    options: [
      {
        name: "Size",
        values: [
          { key: "s", value: "S" },
          { key: "m", value: "M" },
          { key: "l", value: "L" },
        ],
      },
    ],
    variants: [
      V("s", "SHIRT-LIN-S", "S", 128000, 12, {
        compareAtSatang: 160000,
        optionValues: ["s"],
        weightGrams: 260,
        costSatang: 62000,
      }),
      V("m", "SHIRT-LIN-M", "M", 128000, 19, {
        compareAtSatang: 160000,
        optionValues: ["m"],
        weightGrams: 270,
        costSatang: 62000,
      }),
      V("l", "SHIRT-LIN-L", "L", 128000, 2, {
        compareAtSatang: 160000,
        optionValues: ["l"],
        weightGrams: 280,
        costSatang: 62000,
      }),
    ],
  },

  // ── Siam Ceramics · Kitchen ────────────────────────────────
  {
    id: "seed_prod_mug",
    slug: "stoneware-coffee-mug",
    vendor: "Siam Ceramics",
    productType: "Kitchen",
    tags: ["kitchen", "ceramic", "coffee"],
    titleEn: "Stoneware Coffee Mug",
    titleTh: "แก้วกาแฟสโตนแวร์",
    descEn:
      "Hand-glazed stoneware, 300ml. Microwave and dishwasher safe; the glaze keeps coffee hot longer than thin porcelain.",
    descTh:
      "สโตนแวร์เคลือบด้วยมือ ความจุ 300 มล. เข้าไมโครเวฟและเครื่องล้างจานได้ เก็บความร้อนได้ดีกว่าพอร์ซเลนบาง",
    options: [
      {
        name: "Glaze",
        values: [
          { key: "celadon", value: "Celadon", swatchHex: "#9fbfa8" },
          { key: "ash", value: "Ash", swatchHex: "#b9b3a6" },
          { key: "cocoa", value: "Cocoa", swatchHex: "#6b4a35" },
        ],
      },
    ],
    variants: [
      V("celadon", "MUG-STONE-CEL", "Celadon", 28000, 46, {
        optionValues: ["celadon"],
        weightGrams: 420,
        costSatang: 11000,
      }),
      V("ash", "MUG-STONE-ASH", "Ash", 28000, 31, {
        optionValues: ["ash"],
        weightGrams: 420,
        costSatang: 11000,
      }),
      V("cocoa", "MUG-STONE-COC", "Cocoa", 30000, 5, {
        optionValues: ["cocoa"],
        weightGrams: 430,
        costSatang: 12000,
      }),
    ],
  },
  {
    id: "seed_prod_bowl",
    slug: "celadon-rice-bowl",
    vendor: "Siam Ceramics",
    productType: "Kitchen",
    tags: ["kitchen", "ceramic", "tableware"],
    titleEn: "Celadon Rice Bowl",
    titleTh: "ชามข้าวเซลาดอน",
    descEn:
      "Classic Sawankhalok celadon with the crackle glaze the kilns of Sukhothai are known for. 450ml — a proper bowl of rice.",
    descTh:
      "เซลาดอนสังคโลกแบบดั้งเดิม เคลือบราน้ำผึ้งอันเป็นเอกลักษณ์ของเตาสุโขทัย ความจุ 450 มล. ใส่ข้าวได้เต็มชาม",
    variants: [
      V("v1", "BOWL-CELADON", "Default", 34000, 58, {
        weightGrams: 500,
        costSatang: 13000,
      }),
    ],
  },
  {
    id: "seed_prod_teapot",
    slug: "clay-teapot",
    vendor: "Siam Ceramics",
    productType: "Kitchen",
    tags: ["kitchen", "ceramic", "tea"],
    titleEn: "Unglazed Clay Teapot",
    titleTh: "ป้านชาดินเผาไม่เคลือบ",
    descEn:
      "Wheel-thrown red clay, 600ml, with a woven rattan handle. The unglazed interior seasons with use and rounds out the tannins.",
    descTh:
      "ป้านชาดินแดงขึ้นรูปด้วยแป้นหมุน ความจุ 600 มล. หูหวายถัก ผิวในไม่เคลือบจะอมกลิ่นชาและทำให้รสฝาดนุ่มลงเมื่อใช้ไปนาน ๆ",
    variants: [
      V("v1", "TEAPOT-CLAY", "Default", 96000, 0, {
        continueSelling: true,
        weightGrams: 780,
        costSatang: 44000,
      }),
    ],
  },
  {
    id: "seed_prod_apron",
    slug: "linen-kitchen-apron",
    vendor: "Siam Ceramics",
    productType: "Kitchen",
    tags: ["kitchen", "linen"],
    titleEn: "Linen Kitchen Apron",
    titleTh: "ผ้ากันเปื้อนลินิน",
    descEn:
      "Washed linen with adjustable neck strap and a deep front pocket. Softens with every wash.",
    descTh: "ลินินฟอกนุ่ม ปรับสายคอได้ มีกระเป๋าหน้าลึก ยิ่งซักยิ่งนุ่ม",
    variants: [
      V("v1", "APRON-LINEN", "Default", 68000, 25, {
        compareAtSatang: 85000,
        weightGrams: 340,
        costSatang: 31000,
      }),
    ],
  },
  {
    id: "seed_prod_mortar",
    slug: "granite-mortar-pestle",
    vendor: "Siam Ceramics",
    productType: "Kitchen",
    tags: ["kitchen", "stone", "cooking"],
    titleEn: "Granite Mortar & Pestle",
    titleTh: "ครกหินแกรนิตพร้อมสาก",
    descEn:
      "A 6-inch Ang Sila granite mortar — heavy enough to stay put while you pound a curry paste. Rinse, no soap.",
    descTh:
      "ครกหินอ่างศิลาขนาด 6 นิ้ว น้ำหนักดีไม่ขยับเวลาตำพริกแกง ล้างด้วยน้ำเปล่า ไม่ต้องใช้น้ำยา",
    variants: [
      V("v1", "MORTAR-GRANITE", "Default", 78000, 14, {
        weightGrams: 3200,
        costSatang: 36000,
      }),
    ],
  },

  // ── Bangkok Brew Co · Pantry ───────────────────────────────
  {
    id: "seed_prod_coffee",
    slug: "doi-chaang-coffee-beans",
    vendor: "Bangkok Brew Co",
    productType: "Pantry",
    tags: ["coffee", "pantry", "thai-grown"],
    titleEn: "Doi Chaang Coffee Beans",
    titleTh: "เมล็ดกาแฟดอยช้าง",
    descEn:
      "Single-origin arabica from Chiang Rai, medium roast. Tasting notes of cocoa, dried tamarind and a clean citrus finish.",
    descTh:
      "อาราบิก้าซิงเกิลออริจินจากเชียงราย คั่วกลาง ให้กลิ่นโกโก้ มะขามแห้ง และปลายรสส้มสะอาด",
    options: [
      {
        name: "Weight",
        values: [
          { key: "250", value: "250 g" },
          { key: "500", value: "500 g" },
          { key: "1kg", value: "1 kg" },
        ],
      },
      {
        name: "Grind",
        values: [
          { key: "whole", value: "Whole bean" },
          { key: "filter", value: "Filter" },
        ],
      },
    ],
    variants: [
      V("250_whole", "COF-DC-250-W", "250 g / Whole bean", 42000, 88, {
        optionValues: ["250", "whole"],
        weightGrams: 250,
        costSatang: 19000,
      }),
      V("250_filter", "COF-DC-250-F", "250 g / Filter", 42000, 64, {
        optionValues: ["250", "filter"],
        weightGrams: 250,
        costSatang: 19000,
      }),
      V("500_whole", "COF-DC-500-W", "500 g / Whole bean", 78000, 37, {
        compareAtSatang: 84000,
        optionValues: ["500", "whole"],
        weightGrams: 500,
        costSatang: 36000,
      }),
      V("500_filter", "COF-DC-500-F", "500 g / Filter", 78000, 29, {
        compareAtSatang: 84000,
        optionValues: ["500", "filter"],
        weightGrams: 500,
        costSatang: 36000,
      }),
      V("1kg_whole", "COF-DC-1K-W", "1 kg / Whole bean", 145000, 6, {
        optionValues: ["1kg", "whole"],
        weightGrams: 1000,
        costSatang: 68000,
      }),
    ],
  },
  {
    id: "seed_prod_tea",
    slug: "oolong-tea-doi-mae-salong",
    vendor: "Bangkok Brew Co",
    productType: "Pantry",
    tags: ["tea", "pantry", "thai-grown"],
    titleEn: "Doi Mae Salong Oolong",
    titleTh: "ชาอู่หลงดอยแม่สลอง",
    descEn:
      "Hand-rolled No. 17 oolong from 1,200m. Buttery, orchid-sweet, and good for six infusions before it tires.",
    descTh:
      "ชาอู่หลงเบอร์ 17 นวดมือ ปลูกที่ความสูง 1,200 เมตร รสนุ่มกลมกล่อม หอมกล้วยไม้ ชงได้ถึงหกน้ำ",
    variants: [
      V("v1", "TEA-OOLONG-100", "100 g", 52000, 41, {
        weightGrams: 100,
        costSatang: 24000,
      }),
    ],
  },
  {
    id: "seed_prod_curry",
    slug: "southern-curry-paste",
    vendor: "Bangkok Brew Co",
    productType: "Pantry",
    tags: ["pantry", "cooking"],
    titleEn: "Southern Curry Paste",
    titleTh: "น้ำพริกแกงใต้",
    descEn:
      "Pounded to order in small batches — dried chilli, turmeric, lemongrass, galangal and shrimp paste. No preservatives, so keep it cold.",
    descTh:
      "ตำสดทีละครกเล็ก ๆ พริกแห้ง ขมิ้น ตะไคร้ ข่า และกะปิ ไม่ใส่วัตถุกันเสีย ควรเก็บในตู้เย็น",
    variants: [
      V("v1", "PASTE-SOUTH-200", "200 g", 16000, 2, {
        weightGrams: 200,
        costSatang: 6000,
      }),
    ],
  },
  {
    id: "seed_prod_honey",
    slug: "wildflower-honey",
    vendor: "Bangkok Brew Co",
    productType: "Pantry",
    tags: ["pantry", "gift"],
    titleEn: "Northern Wildflower Honey",
    titleTh: "น้ำผึ้งดอกไม้ป่าภาคเหนือ",
    descEn:
      "Raw, unfiltered honey from hives in Nan province. Crystallises in cool weather — that's the proof it was never heated.",
    descTh:
      "น้ำผึ้งดิบไม่ผ่านการกรอง จากรังผึ้งในจังหวัดน่าน ตกผลึกเมื่ออากาศเย็น ซึ่งเป็นเครื่องยืนยันว่าไม่ผ่านความร้อน",
    variants: [
      V("v1", "HONEY-WILD-350", "350 g", 29000, 73, {
        weightGrams: 350,
        costSatang: 12000,
      }),
    ],
  },

  // ── Chao Phraya Paper · Stationery ─────────────────────────
  {
    id: "seed_prod_notebook",
    slug: "recycled-paper-notebook",
    vendor: "Chao Phraya Paper",
    productType: "Stationery",
    tags: ["paper", "everyday"],
    titleEn: "Recycled Paper Notebook",
    titleTh: "สมุดกระดาษรีไซเคิล",
    descEn:
      "96 dot-grid pages of 100% recycled paper, lay-flat binding. Fountain-pen friendly.",
    descTh:
      "กระดาษรีไซเคิล 100% แบบจุดไข่ปลา 96 หน้า เย็บกี่กางราบ ใช้กับปากกาหมึกซึมได้",
    options: [
      {
        name: "Size",
        values: [
          { key: "a5", value: "A5" },
          { key: "a6", value: "A6" },
        ],
      },
    ],
    variants: [
      V("a5", "NOTE-RECYCLED-A5", "A5", 18000, 96, {
        optionValues: ["a5"],
        weightGrams: 210,
        costSatang: 7000,
      }),
      V("a6", "NOTE-RECYCLED-A6", "A6", 13000, 52, {
        optionValues: ["a6"],
        weightGrams: 120,
        costSatang: 5000,
      }),
    ],
  },
  {
    id: "seed_prod_saa_paper",
    slug: "mulberry-saa-paper-set",
    vendor: "Chao Phraya Paper",
    productType: "Stationery",
    tags: ["paper", "gift", "craft"],
    titleEn: "Mulberry Saa Paper Set",
    titleTh: "ชุดกระดาษสาหม่อน",
    descEn:
      "Twenty sheets of hand-pulled saa paper with visible fibre, made the way Chiang Mai workshops have for generations. Takes ink and watercolour equally well.",
    descTh:
      "กระดาษสาทำมือ 20 แผ่น เห็นเส้นใยชัด ผลิตตามวิธีดั้งเดิมของโรงงานเชียงใหม่ที่สืบทอดกันมาหลายรุ่น ใช้กับหมึกและสีน้ำได้ดีทั้งคู่",
    variants: [
      V("v1", "PAPER-SAA-20", "Set of 20", 24000, 38, {
        weightGrams: 300,
        costSatang: 9000,
      }),
    ],
  },
  {
    id: "seed_prod_pen",
    slug: "brass-fountain-pen",
    vendor: "Chao Phraya Paper",
    productType: "Stationery",
    tags: ["gift", "everyday"],
    titleEn: "Brass Fountain Pen",
    titleTh: "ปากกาหมึกซึมทองเหลือง",
    descEn:
      "Solid brass barrel with a German steel medium nib. Heavy in the hand, and it darkens beautifully as it's used.",
    descTh:
      "ด้ามทองเหลืองแท้ หัวปากกาสตีลจากเยอรมนี ขนาดกลาง น้ำหนักดีเวลาจับ และจะคล้ำสวยขึ้นเมื่อใช้ไปเรื่อย ๆ",
    variants: [
      V("v1", "PEN-BRASS-M", "Medium nib", 115000, 9, {
        compareAtSatang: 139000,
        weightGrams: 45,
        costSatang: 55000,
      }),
    ],
  },
  {
    id: "seed_prod_cards",
    slug: "letterpress-card-set",
    vendor: "Chao Phraya Paper",
    productType: "Stationery",
    tags: ["paper", "gift"],
    titleEn: "Letterpress Card Set",
    titleTh: "ชุดการ์ดเลตเตอร์เพรส",
    descEn:
      "Eight blank cards with matching envelopes, pressed on cotton stock deep enough to feel with a fingertip.",
    descTh:
      "การ์ดเปล่า 8 ใบ พร้อมซองที่เข้าชุดกัน พิมพ์บนกระดาษคอตตอน กดลึกจนสัมผัสได้ด้วยปลายนิ้ว",
    variants: [
      V("v1", "CARD-LETTER-8", "Set of 8", 22000, 0, {
        weightGrams: 180,
        costSatang: 8000,
      }),
    ],
  },

  // ── Lamphun Weavers · Home textiles ────────────────────────
  {
    id: "seed_prod_throw",
    slug: "handwoven-cotton-throw",
    vendor: "Lamphun Weavers",
    productType: "Home Textiles",
    tags: ["home", "cotton", "handmade"],
    titleEn: "Handwoven Cotton Throw",
    titleTh: "ผ้าคลุมคอตตอนทอมือ",
    descEn:
      "Woven on a floor loom in Lamphun, 130×180cm, with a slubby texture no machine reproduces. Naturally dyed with indigo and ebony bark.",
    descTh:
      "ทอด้วยกี่กระตุกที่ลำพูน ขนาด 130×180 ซม. ผิวสัมผัสเป็นปุ่มปมแบบที่เครื่องจักรทำไม่ได้ ย้อมสีธรรมชาติจากครามและเปลือกมะเกลือ",
    options: [
      {
        name: "Colour",
        values: [
          { key: "indigo", value: "Indigo", swatchHex: "#33456e" },
          { key: "ebony", value: "Ebony", swatchHex: "#2a2622" },
        ],
      },
    ],
    variants: [
      V("indigo", "THROW-COT-IND", "Indigo", 165000, 16, {
        optionValues: ["indigo"],
        weightGrams: 900,
        costSatang: 78000,
      }),
      V("ebony", "THROW-COT-EBO", "Ebony", 165000, 7, {
        optionValues: ["ebony"],
        weightGrams: 900,
        costSatang: 78000,
      }),
    ],
  },
  {
    id: "seed_prod_cushion",
    slug: "ikat-cushion-cover",
    vendor: "Lamphun Weavers",
    productType: "Home Textiles",
    tags: ["home", "handmade"],
    titleEn: "Ikat Cushion Cover",
    titleTh: "ปลอกหมอนอิงลายมัดหมี่",
    descEn:
      "45×45cm cover in mudmee ikat — the pattern is dyed into the yarn before weaving, so it's identical on both faces. Hidden zip.",
    descTh:
      "ปลอกหมอนขนาด 45×45 ซม. ลายมัดหมี่ ย้อมลายลงบนเส้นด้ายก่อนทอ ลายจึงเหมือนกันทั้งสองด้าน ซิปซ่อน",
    variants: [
      V("v1", "CUSH-IKAT-45", "45 × 45 cm", 58000, 24, {
        compareAtSatang: 72000,
        weightGrams: 220,
        costSatang: 26000,
      }),
    ],
  },
  {
    id: "seed_prod_runner",
    slug: "cotton-table-runner",
    vendor: "Lamphun Weavers",
    productType: "Home Textiles",
    tags: ["home", "cotton", "tableware"],
    titleEn: "Cotton Table Runner",
    titleTh: "ผ้าปูโต๊ะยาวคอตตอน",
    descEn:
      "40×200cm of plain-weave cotton with hand-knotted fringe. Long enough for a six-seater with a little overhang.",
    descTh:
      "ผ้าคอตตอนทอลายขัด ขนาด 40×200 ซม. ชายผ้าถักมือ ยาวพอสำหรับโต๊ะหกที่นั่งและเหลือปลายห้อยเล็กน้อย",
    variants: [
      V("v1", "RUNNER-COT-200", "Default", 72000, 19, {
        weightGrams: 400,
        costSatang: 33000,
      }),
    ],
  },
  {
    id: "seed_prod_napkins",
    slug: "linen-napkin-set",
    vendor: "Lamphun Weavers",
    productType: "Home Textiles",
    tags: ["home", "linen", "tableware", "gift"],
    titleEn: "Linen Napkin Set",
    titleTh: "ชุดผ้าเช็ดปากลินิน",
    descEn:
      "Four stonewashed linen napkins, 45cm square, with mitred corners. They only get softer from here.",
    descTh:
      "ผ้าเช็ดปากลินินฟอกหิน 4 ผืน ขนาด 45 ซม. เย็บมุมเข้ามุม ยิ่งใช้ยิ่งนุ่มขึ้นเรื่อย ๆ",
    variants: [
      V("v1", "NAPKIN-LIN-4", "Set of 4", 48000, 33, {
        weightGrams: 260,
        costSatang: 21000,
      }),
    ],
  },
];

// ─── Collections ────────────────────────────────────────────

type SeedCollection = {
  id: string;
  slug: string;
  titleEn: string;
  titleTh: string;
  descEn: string;
  descTh: string;
  productIds: string[];
};

const collections: SeedCollection[] = [
  {
    id: "seed_coll_new",
    slug: "new-arrivals",
    titleEn: "New Arrivals",
    titleTh: "สินค้ามาใหม่",
    descEn: "The most recent additions to the shop, restocked weekly.",
    descTh: "สินค้าที่เพิ่งเข้าร้านล่าสุด เติมของใหม่ทุกสัปดาห์",
    productIds: [
      "seed_prod_daypack",
      "seed_prod_teapot",
      "seed_prod_saa_paper",
      "seed_prod_throw",
      "seed_prod_camp_shirt",
      "seed_prod_honey",
    ],
  },
  {
    id: "seed_coll_kitchen",
    slug: "kitchen",
    titleEn: "Kitchen & Table",
    titleTh: "ครัวและโต๊ะอาหาร",
    descEn: "Stoneware, stone tools and textiles for cooking and eating well.",
    descTh: "เครื่องสโตนแวร์ เครื่องครัวหิน และผ้าสำหรับการทำอาหารและมื้อดี ๆ",
    productIds: [
      "seed_prod_mug",
      "seed_prod_bowl",
      "seed_prod_teapot",
      "seed_prod_apron",
      "seed_prod_mortar",
      "seed_prod_runner",
      "seed_prod_napkins",
    ],
  },
  {
    id: "seed_coll_carry",
    slug: "everyday-carry",
    titleEn: "Everyday Carry",
    titleTh: "ของใช้ติดตัวประจำวัน",
    descEn: "Bags, pouches and pens that earn their place in your hands daily.",
    descTh: "กระเป๋า ซองใส่ของ และปากกา ที่คู่ควรกับการหยิบใช้ทุกวัน",
    productIds: [
      "seed_prod_tote",
      "seed_prod_daypack",
      "seed_prod_pouch",
      "seed_prod_notebook",
      "seed_prod_pen",
      "seed_prod_tee",
    ],
  },
  {
    id: "seed_coll_sale",
    slug: "sale",
    titleEn: "Sale",
    titleTh: "ลดราคา",
    descEn: "Marked down while stock lasts — no restock once these are gone.",
    descTh: "ลดราคาจนกว่าของจะหมด สินค้าชุดนี้ไม่มีเติมเพิ่ม",
    productIds: [
      "seed_prod_tote",
      "seed_prod_camp_shirt",
      "seed_prod_apron",
      "seed_prod_coffee",
      "seed_prod_cushion",
      "seed_prod_pen",
    ],
  },
  {
    id: "seed_coll_gifts",
    slug: "gifts-under-1000",
    titleEn: "Gifts Under ฿1,000",
    titleTh: "ของขวัญไม่เกิน 1,000 บาท",
    descEn: "Well-made things that travel light and don't need a size guess.",
    descTh: "ของดีทำประณีต พกพาสะดวก และไม่ต้องเดาไซซ์",
    productIds: [
      "seed_prod_mug",
      "seed_prod_bowl",
      "seed_prod_honey",
      "seed_prod_tea",
      "seed_prod_saa_paper",
      "seed_prod_cards",
      "seed_prod_pouch",
      "seed_prod_napkins",
    ],
  },
];

// ─── Reviews ────────────────────────────────────────────────

type SeedReview = {
  id: string;
  productId: string;
  email: string;
  rating: number;
  title: string;
  body: string;
  locale: "en" | "th";
  status?: "pending" | "approved" | "rejected";
  verified?: boolean;
  daysAgo: number;
};

const reviews: SeedReview[] = [
  {
    id: "seed_rev_tote_1",
    productId: "seed_prod_tote",
    email: "napat.s@example.com",
    rating: 5,
    title: "Carries far more than it looks like it should",
    body: "I've had this six months of daily commuting with a 15-inch laptop and a water bottle in it. The handle stitching hasn't budged. The natural colour does show marks, but they wash out.",
    locale: "en",
    verified: true,
    daysAgo: 26,
  },
  {
    id: "seed_rev_tote_2",
    productId: "seed_prod_tote",
    email: "ploy.k@example.com",
    rating: 4,
    title: "ผ้าหนาดี แต่สีธรรมชาติเลอะง่าย",
    body: "ผ้าแคนวาสหนาแน่นสมราคา ใส่ของหนักได้ไม่กลัวขาด หักไปหนึ่งดาวเพราะสีธรรมชาติเปื้อนง่ายมาก ถ้าซื้อใหม่คงเลือกสีคราม",
    locale: "th",
    verified: true,
    daysAgo: 19,
  },
  {
    id: "seed_rev_tote_3",
    productId: "seed_prod_tote",
    email: "j.harrington@example.com",
    rating: 3,
    title: "Good bag, no inner pocket",
    body: "Solid construction, but there is nowhere to put keys or a phone so everything sinks to the bottom. Fine if you carry a pouch inside it.",
    locale: "en",
    daysAgo: 11,
  },
  {
    id: "seed_rev_mug_1",
    productId: "seed_prod_mug",
    email: "siriporn.w@example.com",
    rating: 5,
    title: "แก้วเก็บความร้อนได้จริง",
    body: "กาแฟยังอุ่นอยู่หลังผ่านไปยี่สิบนาที ซึ่งแก้วบางทำไม่ได้ เคลือบเซลาดอนสวยมาก แต่ละใบสีไม่เหมือนกันเป๊ะ ชอบตรงนี้",
    locale: "th",
    verified: true,
    daysAgo: 24,
  },
  {
    id: "seed_rev_mug_2",
    productId: "seed_prod_mug",
    email: "marcus.l@example.com",
    rating: 4,
    title: "Beautiful, slightly small",
    body: "300ml is one espresso-based drink, not a mug of filter coffee. Lovely glaze and it survived the dishwasher fine.",
    locale: "en",
    verified: true,
    daysAgo: 15,
  },
  {
    id: "seed_rev_mug_3",
    productId: "seed_prod_mug",
    email: "anon.buyer@example.com",
    rating: 2,
    title: "Arrived chipped",
    body: "One of the two mugs had a chip on the base rim. Support replaced it quickly, but the packing could use more padding.",
    locale: "en",
    status: "approved",
    daysAgo: 8,
  },
  {
    id: "seed_rev_coffee_1",
    productId: "seed_prod_coffee",
    email: "krit.t@example.com",
    rating: 5,
    title: "คั่วกลางที่บาลานซ์ดีมาก",
    body: "สั่งแบบเมล็ดไม่บด 500 กรัม กลิ่นโกโก้ชัดตอนบด ดริปออกมาไม่เปรี้ยวจัด เหมาะกับคนที่ไม่ชอบคั่วอ่อนเปรี้ยว ๆ สั่งซ้ำแน่นอน",
    locale: "th",
    verified: true,
    daysAgo: 21,
  },
  {
    id: "seed_rev_coffee_2",
    productId: "seed_prod_coffee",
    email: "dana.r@example.com",
    rating: 4,
    title: "Fresh, but check the roast date",
    body: "Genuinely good Thai arabica and the tamarind note in the description is real. Mine arrived nine days off roast which is fine, but I'd have liked it fresher for the price.",
    locale: "en",
    verified: true,
    daysAgo: 13,
  },
  {
    id: "seed_rev_coffee_3",
    productId: "seed_prod_coffee",
    email: "pattama.n@example.com",
    rating: 5,
    title: "บดละเอียดมาให้พอดีกับดริปเปอร์",
    body: "สั่งแบบบดสำหรับดริป ขนาดบดกำลังดี ไม่ต้องปรับอะไรเพิ่ม แพ็กมาแน่นหนา มีวาล์วระบายแก๊สด้วย",
    locale: "th",
    daysAgo: 6,
  },
  {
    id: "seed_rev_throw_1",
    productId: "seed_prod_throw",
    email: "elise.v@example.com",
    rating: 5,
    title: "Worth the price for a handwoven piece",
    body: "You can see the loom variation across the width and that's exactly what I wanted. The indigo bled a little on the first cold wash, then stopped.",
    locale: "en",
    verified: true,
    daysAgo: 18,
  },
  {
    id: "seed_rev_throw_2",
    productId: "seed_prod_throw",
    email: "wanida.p@example.com",
    rating: 4,
    title: "ทอสวยมาก แต่ต้องซักแยกครั้งแรก",
    body: "เนื้อผ้าดีมาก สีครามย้อมธรรมชาติสวยลึก ครั้งแรกสีตกนิดหน่อยต้องซักแยก หลังจากนั้นไม่มีปัญหา",
    locale: "th",
    verified: true,
    daysAgo: 9,
  },
  {
    id: "seed_rev_tee_1",
    productId: "seed_prod_tee",
    email: "somchai.b@example.com",
    rating: 4,
    title: "ทรงดี ใส่สบาย ไซซ์ค่อนข้างใหญ่",
    body: "ปกติใส่ M แต่ตัวนี้ M ค่อนข้างหลวม ใครชอบทรงพอดีตัวแนะนำให้ลดไซซ์ลงหนึ่งขนาด ผ้านุ่มดี ซักแล้วไม่หด",
    locale: "th",
    verified: true,
    daysAgo: 22,
  },
  {
    id: "seed_rev_tee_2",
    productId: "seed_prod_tee",
    email: "chris.oy@example.com",
    rating: 3,
    title: "Fine tee, thin in black",
    body: "The sand colour is a good weight but the black is noticeably more see-through. Cut and shoulders are good on both.",
    locale: "en",
    daysAgo: 12,
  },
  {
    id: "seed_rev_notebook_1",
    productId: "seed_prod_notebook",
    email: "ratchanon.i@example.com",
    rating: 5,
    title: "Recycled paper that actually takes fountain ink",
    body: "No feathering with a medium nib and only the faintest ghosting. The lay-flat binding is the real feature — it stays open at page one.",
    locale: "en",
    verified: true,
    daysAgo: 17,
  },
  {
    id: "seed_rev_notebook_2",
    productId: "seed_prod_notebook",
    email: "bua.c@example.com",
    rating: 4,
    title: "กระดาษดีเกินราคา",
    body: "กระดาษรีไซเคิลแต่เขียนลื่น หมึกไม่ซึมทะลุ ขนาด A5 พกพาง่าย อยากให้มีแบบปกแข็งด้วย",
    locale: "th",
    daysAgo: 5,
  },
  {
    id: "seed_rev_mortar_1",
    productId: "seed_prod_mortar",
    email: "nuch.a@example.com",
    rating: 5,
    title: "ครกหนักดี ตำพริกแกงไม่ขยับ",
    body: "หินอ่างศิลาของจริง หนักมากแต่นั่นแหละคือข้อดี ตำน้ำพริกแกงเผ็ดได้ละเอียดโดยครกไม่เลื่อนไปไหน ล้างครั้งแรกต้องล้างหลายรอบให้ผงหินออก",
    locale: "th",
    verified: true,
    daysAgo: 20,
  },
  {
    id: "seed_rev_mortar_2",
    productId: "seed_prod_mortar",
    email: "tomas.k@example.com",
    rating: 4,
    title: "Heavy, as it should be",
    body: "Season it first — mine shed grit for the first two rinses. After that it has been perfect for curry pastes.",
    locale: "en",
    daysAgo: 7,
  },
  {
    id: "seed_rev_apron_1",
    productId: "seed_prod_apron",
    email: "fern.s@example.com",
    rating: 5,
    title: "The pocket is deep enough to be useful",
    body: "Most aprons have a token pocket. This one holds a phone and a towel without either falling out when you lean over the counter.",
    locale: "en",
    verified: true,
    daysAgo: 14,
  },
  {
    id: "seed_rev_pen_1",
    productId: "seed_prod_pen",
    email: "auree.m@example.com",
    rating: 3,
    title: "Gorgeous but heavy for long sessions",
    body: "The brass looks and feels superb and the nib is smooth out of the box. My hand tires after two pages though, so it's become a signing pen rather than a journaling one.",
    locale: "en",
    verified: true,
    daysAgo: 10,
  },
  {
    id: "seed_rev_pen_2",
    productId: "seed_prod_pen",
    email: "korn.j@example.com",
    rating: 5,
    title: "ทองเหลืองแท้ น้ำหนักดี",
    body: "ด้ามหนักกำลังดีสำหรับคนชอบปากกาหนัก หัว M เขียนลื่นตั้งแต่แกะกล่อง ใช้ไปสักพักทองเหลืองเริ่มคล้ำสวยตามที่โฆษณาไว้จริง",
    locale: "th",
    daysAgo: 4,
  },
  {
    id: "seed_rev_teapot_1",
    productId: "seed_prod_teapot",
    email: "lena.q@example.com",
    rating: 4,
    title: "Pours clean, handle runs hot",
    body: "No dribble at all, which is rare. The rattan handle does warm up with boiling water so I use a cloth. Seasoning is noticeable after about ten brews.",
    locale: "en",
    daysAgo: 16,
  },
  {
    id: "seed_rev_bowl_1",
    productId: "seed_prod_bowl",
    email: "yui.t@example.com",
    rating: 5,
    title: "ลายรานสวยมาก ขนาดพอดีมือ",
    body: "เคลือบรานแบบสังคโลกสวยจริง จับถนัดมือ ใส่ข้าวได้พอดีหนึ่งจาน เข้าไมโครเวฟได้ไม่มีปัญหา ซื้อเพิ่มอีกสองใบ",
    locale: "th",
    verified: true,
    daysAgo: 23,
  },
  {
    id: "seed_rev_cushion_1",
    productId: "seed_prod_cushion",
    email: "grace.d@example.com",
    rating: 4,
    title: "True mudmee, both sides usable",
    body: "The pattern really is identical front and back. Slightly smaller than 45cm after washing, so buy a 45cm insert and expect it snug.",
    locale: "en",
    verified: true,
    daysAgo: 3,
  },
  {
    id: "seed_rev_pending_1",
    productId: "seed_prod_daypack",
    email: "unverified.new@example.com",
    rating: 5,
    title: "Best pack I have owned",
    body: "Waiting on moderation — posted this the day it arrived, so treat it as a first impression rather than a durability test.",
    locale: "en",
    status: "pending",
    daysAgo: 1,
  },
];

// ─── Discounts ──────────────────────────────────────────────

type SeedDiscount = {
  id: string;
  code: string;
  method: "code" | "automatic";
  kind: "fixed_satang" | "percent" | "free_shipping";
  valueSatang?: number;
  valuePercent?: number;
  maxRedemptions?: number;
  maxPerCustomer?: number;
  minOrderSatang?: number;
  startsAtDaysAgo?: number;
  endsInDays?: number;
  active?: boolean;
  description: string;
};

const discounts: SeedDiscount[] = [
  {
    id: "seed_disc_welcome10",
    code: "WELCOME10",
    method: "code",
    kind: "percent",
    valuePercent: 10,
    maxPerCustomer: 1,
    minOrderSatang: 50000,
    startsAtDaysAgo: 90,
    description: "10% off a first order over ฿500",
  },
  {
    id: "seed_disc_songkran",
    code: "SONGKRAN150",
    method: "code",
    kind: "fixed_satang",
    valueSatang: 15000,
    maxRedemptions: 200,
    maxPerCustomer: 1,
    minOrderSatang: 80000,
    startsAtDaysAgo: 40,
    endsInDays: 20,
    description: "฿150 off orders over ฿800 — Songkran campaign",
  },
  {
    id: "seed_disc_freeship",
    code: "FREESHIP",
    method: "code",
    kind: "free_shipping",
    minOrderSatang: 100000,
    startsAtDaysAgo: 60,
    description: "Free shipping over ฿1,000",
  },
  {
    id: "seed_disc_auto_bulk",
    code: "AUTO-SEED-BULK5",
    method: "automatic",
    kind: "percent",
    valuePercent: 5,
    minOrderSatang: 250000,
    startsAtDaysAgo: 30,
    description: "Automatic 5% off baskets over ฿2,500",
  },
  {
    id: "seed_disc_expired",
    code: "NEWYEAR2025",
    method: "code",
    kind: "percent",
    valuePercent: 15,
    maxRedemptions: 500,
    startsAtDaysAgo: 240,
    endsInDays: -180,
    active: false,
    description: "Expired New Year campaign — kept for reporting history",
  },
];

// ─── Orders ─────────────────────────────────────────────────

type SeedOrderLine = { variantKey: string; qty: number };

type SeedOrder = {
  id: string;
  number: string;
  email: string;
  daysAgo: number;
  financial:
    | "pending"
    | "paid"
    | "partially_refunded"
    | "refunded"
    | "cancelled";
  fulfillment: "unfulfilled" | "fulfilled" | "delivered";
  channel?: "online_store" | "tonbab_pos";
  lines: SeedOrderLine[];
  shippingSatang?: number;
  discountId?: string;
  discountCode?: string;
  discountSatang?: number;
  /** Refund amounts (positive satang) written into the adjustments ledger. */
  refunds?: {
    amount: number;
    kind: "refund_full" | "refund_partial";
    reason: string;
  }[];
  /** Refund the whole computed order total — amount resolved after totals. */
  refundFull?: { kind: "refund_full"; reason: string };
  providerName?: string;
  city?: string;
};

/** `variantKey` is `<productId>|<variantKey>` — resolved to a variant id below. */
const orders: SeedOrder[] = [
  {
    id: "seed_order_01",
    number: "KHP-2026-90001",
    email: "napat.s@example.com",
    daysAgo: 28,
    financial: "paid",
    fulfillment: "delivered",
    lines: [
      { variantKey: "seed_prod_tote|natural", qty: 1 },
      { variantKey: "seed_prod_pouch|v1", qty: 1 },
    ],
    shippingSatang: 5000,
    city: "Bangkok",
  },
  {
    id: "seed_order_02",
    number: "KHP-2026-90002",
    email: "siriporn.w@example.com",
    daysAgo: 26,
    financial: "paid",
    fulfillment: "delivered",
    lines: [
      { variantKey: "seed_prod_mug|celadon", qty: 2 },
      { variantKey: "seed_prod_bowl|v1", qty: 4 },
    ],
    shippingSatang: 5000,
    discountId: "seed_disc_welcome10",
    discountCode: "WELCOME10",
    city: "Chiang Mai",
  },
  {
    id: "seed_order_03",
    number: "KHP-2026-90003",
    email: "krit.t@example.com",
    daysAgo: 24,
    financial: "paid",
    fulfillment: "delivered",
    lines: [{ variantKey: "seed_prod_coffee|500_whole", qty: 2 }],
    shippingSatang: 5000,
    city: "Bangkok",
  },
  {
    id: "seed_order_04",
    number: "KHP-2026-90004",
    email: "walk-in@tonbab.local",
    daysAgo: 22,
    financial: "paid",
    fulfillment: "delivered",
    channel: "tonbab_pos",
    lines: [
      { variantKey: "seed_prod_mug|ash", qty: 1 },
      { variantKey: "seed_prod_honey|v1", qty: 2 },
    ],
    shippingSatang: 0,
    providerName: "tonbab",
    city: "Bangkok",
  },
  {
    id: "seed_order_05",
    number: "KHP-2026-90005",
    email: "elise.v@example.com",
    daysAgo: 19,
    financial: "partially_refunded",
    fulfillment: "delivered",
    lines: [
      { variantKey: "seed_prod_throw|indigo", qty: 1 },
      { variantKey: "seed_prod_cushion|v1", qty: 2 },
    ],
    shippingSatang: 8000,
    refunds: [
      {
        amount: 58000,
        kind: "refund_partial",
        reason:
          "One cushion cover arrived with a seam fault — refunded that line",
      },
    ],
    city: "Phuket",
  },
  {
    id: "seed_order_06",
    number: "KHP-2026-90006",
    email: "somchai.b@example.com",
    daysAgo: 17,
    financial: "paid",
    fulfillment: "delivered",
    lines: [
      { variantKey: "seed_prod_tee|m_black", qty: 2 },
      { variantKey: "seed_prod_tee|l_sand", qty: 1 },
    ],
    shippingSatang: 5000,
    city: "Nonthaburi",
  },
  {
    id: "seed_order_07",
    number: "KHP-2026-90007",
    email: "ratchanon.i@example.com",
    daysAgo: 15,
    financial: "paid",
    fulfillment: "fulfilled",
    lines: [
      { variantKey: "seed_prod_notebook|a5", qty: 3 },
      { variantKey: "seed_prod_pen|v1", qty: 1 },
    ],
    shippingSatang: 5000,
    discountId: "seed_disc_freeship",
    discountCode: "FREESHIP",
    city: "Khon Kaen",
  },
  {
    id: "seed_order_08",
    number: "KHP-2026-90008",
    email: "cancelled.customer@example.com",
    daysAgo: 13,
    financial: "cancelled",
    fulfillment: "unfulfilled",
    lines: [{ variantKey: "seed_prod_daypack|v1", qty: 1 }],
    shippingSatang: 8000,
    city: "Bangkok",
  },
  {
    id: "seed_order_09",
    number: "KHP-2026-90009",
    email: "walk-in@tonbab.local",
    daysAgo: 11,
    financial: "paid",
    fulfillment: "delivered",
    channel: "tonbab_pos",
    lines: [
      { variantKey: "seed_prod_curry|v1", qty: 3 },
      { variantKey: "seed_prod_tea|v1", qty: 1 },
    ],
    shippingSatang: 0,
    providerName: "tonbab",
    city: "Bangkok",
  },
  {
    id: "seed_order_10",
    number: "KHP-2026-90010",
    email: "grace.d@example.com",
    daysAgo: 9,
    financial: "paid",
    fulfillment: "fulfilled",
    lines: [
      { variantKey: "seed_prod_runner|v1", qty: 1 },
      { variantKey: "seed_prod_napkins|v1", qty: 2 },
    ],
    shippingSatang: 5000,
    city: "Bangkok",
  },
  {
    id: "seed_order_11",
    number: "KHP-2026-90011",
    email: "marcus.l@example.com",
    daysAgo: 7,
    financial: "refunded",
    fulfillment: "unfulfilled",
    lines: [{ variantKey: "seed_prod_camp_shirt|l", qty: 1 }],
    shippingSatang: 5000,
    // `refundFull: true` makes the ledger row exactly total_satang, so
    // the ledger-derived financial_status (refundedTotal >= total →
    // 'refunded') agrees with the column written above.
    refundFull: {
      kind: "refund_full",
      reason:
        "Customer cancelled before dispatch — full refund including shipping",
    },
    city: "Bangkok",
  },
  {
    id: "seed_order_12",
    number: "KHP-2026-90012",
    email: "wanida.p@example.com",
    daysAgo: 5,
    financial: "paid",
    fulfillment: "fulfilled",
    lines: [
      { variantKey: "seed_prod_throw|ebony", qty: 1 },
      { variantKey: "seed_prod_mortar|v1", qty: 1 },
    ],
    shippingSatang: 8000,
    discountId: "seed_disc_auto_bulk",
    discountCode: "AUTO-SEED-BULK5",
    city: "Lampang",
  },
  {
    id: "seed_order_13",
    number: "KHP-2026-90013",
    email: "fern.s@example.com",
    daysAgo: 3,
    financial: "paid",
    fulfillment: "unfulfilled",
    lines: [
      { variantKey: "seed_prod_apron|v1", qty: 1 },
      { variantKey: "seed_prod_teapot|v1", qty: 1 },
    ],
    shippingSatang: 5000,
    city: "Bangkok",
  },
  {
    id: "seed_order_14",
    number: "KHP-2026-90014",
    email: "pending.checkout@example.com",
    daysAgo: 2,
    financial: "pending",
    fulfillment: "unfulfilled",
    lines: [{ variantKey: "seed_prod_saa_paper|v1", qty: 2 }],
    shippingSatang: 5000,
    city: "Bangkok",
  },
  {
    id: "seed_order_15",
    number: "KHP-2026-90015",
    email: "yui.t@example.com",
    daysAgo: 1,
    financial: "pending",
    fulfillment: "unfulfilled",
    lines: [
      { variantKey: "seed_prod_coffee|250_filter", qty: 1 },
      { variantKey: "seed_prod_cards|v1", qty: 1 },
    ],
    shippingSatang: 5000,
    city: "Songkhla",
  },
];

// ─── SQL generation ─────────────────────────────────────────

const VAT_RATE = 0.07; // Thailand VAT — orders are seeded tax-exclusive.
const lines: string[] = [];
const productIds = products.map((p) => p.id);
const inList = (ids: string[]) => ids.map(q).join(", ");

/** Mirrors deriveLegacyStatus() in order-service.ts. */
const deriveLegacyStatus = (
  financial: SeedOrder["financial"],
  fulfillment: SeedOrder["fulfillment"],
): string => {
  if (financial === "cancelled") return "cancelled";
  if (financial === "refunded") return "refunded";
  if (financial === "pending") return "pending";
  if (fulfillment === "delivered") return "delivered";
  if (fulfillment === "fulfilled") return "fulfilled";
  return "paid";
};

lines.push("-- Generated by scripts/seed-shop-demo.ts — do not edit by hand.");
lines.push("PRAGMA defer_foreign_keys = ON;");

// Clean out join/child rows for the seed set first — these have no
// single-column identity that INSERT OR REPLACE can key on, so a
// re-run with a changed fixture would otherwise leave orphans.
lines.push(
  `DELETE FROM shop_collection_products WHERE collection_id IN (${inList(collections.map((c) => c.id))});`,
);
lines.push(
  `DELETE FROM shop_product_variant_options WHERE variant_id LIKE 'seed_prod_%';`,
);
lines.push(
  `DELETE FROM shop_product_option_values WHERE option_id LIKE 'seed_prod_%';`,
);
lines.push(
  `DELETE FROM shop_product_options WHERE product_id IN (${inList(productIds)});`,
);
lines.push(
  `DELETE FROM shop_order_adjustments WHERE order_id IN (${inList(orders.map((o) => o.id))});`,
);
lines.push(
  `DELETE FROM shop_order_items WHERE order_id IN (${inList(orders.map((o) => o.id))});`,
);
lines.push(
  `DELETE FROM shop_discount_redemptions WHERE order_id IN (${inList(orders.map((o) => o.id))});`,
);
lines.push(
  `DELETE FROM products_fts WHERE product_id IN (${inList(productIds)});`,
);

// ── Products, options, variants, inventory ──
const variantIndex = new Map<
  string,
  SeedVariant & { id: string; productId: string }
>();

for (const p of products) {
  lines.push(
    `INSERT OR REPLACE INTO shop_products (id, slug, status, vendor, product_type, tags, featured_media_id, seo_title, seo_description, created_at, updated_at, published_at) VALUES (` +
      `${q(p.id)}, ${q(p.slug)}, 'active', ${q(p.vendor)}, ${q(p.productType)}, ${q(JSON.stringify(p.tags))}, NULL, ` +
      `${q(p.titleEn)}, ${q(p.descEn.slice(0, 155))}, ${q(now)}, ${q(now)}, ${q(now)});`,
  );

  for (const [locale, title, desc] of [
    ["en", p.titleEn, p.descEn],
    ["th", p.titleTh, p.descTh],
  ] as const) {
    lines.push(
      `INSERT OR REPLACE INTO shop_product_localizations (product_id, locale, title, description_markdown) VALUES (` +
        `${q(p.id)}, ${q(locale)}, ${q(title)}, ${q(desc)});`,
    );
  }

  // Options + option values. Option/value ids are prefixed with the
  // product id so the LIKE-based cleanup above catches them.
  const valueIdByKey = new Map<string, string>();
  p.options?.forEach((opt, i) => {
    const optId = `${p.id}_opt${i + 1}`;
    lines.push(
      `INSERT OR REPLACE INTO shop_product_options (id, product_id, name, position) VALUES (` +
        `${q(optId)}, ${q(p.id)}, ${q(opt.name)}, ${i + 1});`,
    );
    opt.values.forEach((v, vi) => {
      const valId = `${optId}_${v.key}`;
      valueIdByKey.set(v.key, valId);
      lines.push(
        `INSERT OR REPLACE INTO shop_product_option_values (id, option_id, value, sort_order, swatch_hex) VALUES (` +
          `${q(valId)}, ${q(optId)}, ${q(v.value)}, ${vi}, ${nul(v.swatchHex ?? null)});`,
      );
    });
  });

  p.variants.forEach((v, vi) => {
    const variantId = `${p.id}_${v.key}`;
    const itemId = `${variantId}_inv`;
    variantIndex.set(`${p.id}|${v.key}`, {
      ...v,
      id: variantId,
      productId: p.id,
    });

    lines.push(
      `INSERT OR REPLACE INTO shop_product_variants (id, product_id, sku, barcode, status, title_cached, price_satang, compare_at_satang, weight_grams, requires_shipping, taxable, position, media_id) VALUES (` +
        `${q(variantId)}, ${q(p.id)}, ${q(v.sku)}, NULL, 'active', ${q(v.title)}, ${v.priceSatang}, ` +
        `${nul(v.compareAtSatang ?? null)}, ${nul(v.weightGrams ?? null)}, 1, 1, ${vi + 1}, NULL);`,
    );

    for (const key of v.optionValues ?? []) {
      const valId = valueIdByKey.get(key);
      if (!valId)
        throw new Error(
          `${p.id}: variant ${v.key} references unknown option value '${key}'`,
        );
      lines.push(
        `INSERT OR REPLACE INTO shop_product_variant_options (variant_id, option_value_id) VALUES (${q(variantId)}, ${q(valId)});`,
      );
    }

    lines.push(
      `INSERT OR REPLACE INTO shop_inventory_items (id, variant_id, tracked, cost_satang, continue_selling_when_out_of_stock) VALUES (` +
        `${q(itemId)}, ${q(variantId)}, 1, ${nul(v.costSatang ?? null)}, ${v.continueSelling ? 1 : 0});`,
    );
    lines.push(
      `INSERT OR REPLACE INTO shop_inventory_levels (item_id, location_id, on_hand, reserved) VALUES (` +
        `${q(itemId)}, 'default', ${v.onHand}, 0);`,
    );
  });
}

// ── FTS (app-synced, no triggers — seeded rows are invisible to
// search unless indexed here). Both locales for every product. ──
for (const p of products) {
  for (const [locale, title, desc] of [
    ["en", p.titleEn, p.descEn],
    ["th", p.titleTh, p.descTh],
  ] as const) {
    lines.push(
      `INSERT INTO products_fts (title, description, locale, product_id) VALUES (` +
        `${q(title)}, ${q(desc)}, ${q(locale)}, ${q(p.id)});`,
    );
  }
}

// ── Collections ──
for (const c of collections) {
  lines.push(
    `INSERT OR REPLACE INTO shop_collections (id, slug, status, kind, rules_json, featured_media_id, seo_title, seo_description, created_at, updated_at, published_at) VALUES (` +
      `${q(c.id)}, ${q(c.slug)}, 'active', 'manual', NULL, NULL, ${q(c.titleEn)}, ${q(c.descEn)}, ${q(now)}, ${q(now)}, ${q(now)});`,
  );
  for (const [locale, title, desc] of [
    ["en", c.titleEn, c.descEn],
    ["th", c.titleTh, c.descTh],
  ] as const) {
    lines.push(
      `INSERT OR REPLACE INTO shop_collection_localizations (collection_id, locale, title, description_markdown) VALUES (` +
        `${q(c.id)}, ${q(locale)}, ${q(title)}, ${q(desc)});`,
    );
  }
  c.productIds.forEach((pid, i) => {
    if (!productIds.includes(pid))
      throw new Error(`${c.id}: unknown product '${pid}'`);
    lines.push(
      `INSERT OR REPLACE INTO shop_collection_products (collection_id, product_id, position) VALUES (${q(c.id)}, ${q(pid)}, ${i});`,
    );
  });
}

// ── Discounts ──
for (const d of discounts) {
  const startsAt =
    d.startsAtDaysAgo !== undefined ? daysAgo(d.startsAtDaysAgo) : null;
  const endsAt = d.endsInDays !== undefined ? daysAgo(-d.endsInDays) : null;
  lines.push(
    `INSERT OR REPLACE INTO shop_discount_codes (id, code, method, kind, value_satang, value_percent, max_redemptions, max_per_customer, min_order_satang, starts_at, ends_at, active, description, created_by, created_at, updated_at) VALUES (` +
      `${q(d.id)}, ${q(d.code)}, ${q(d.method)}, ${q(d.kind)}, ${nul(d.valueSatang ?? null)}, ${nul(d.valuePercent ?? null)}, ` +
      `${nul(d.maxRedemptions ?? null)}, ${nul(d.maxPerCustomer ?? null)}, ${nul(d.minOrderSatang ?? null)}, ` +
      `${nul(startsAt)}, ${nul(endsAt)}, ${d.active === false ? 0 : 1}, ${q(d.description)}, 'seed', ${q(now)}, ${q(now)});`,
  );
}

// ── Reviews ──
for (const r of reviews) {
  lines.push(
    `INSERT OR REPLACE INTO product_reviews (id, product_id, order_id, email, rating, title, body, locale, status, verified, ip_hash, created_at) VALUES (` +
      `${q(r.id)}, ${q(r.productId)}, NULL, ${q(r.email)}, ${r.rating}, ${q(r.title)}, ${q(r.body)}, ${q(r.locale)}, ` +
      `${q(r.status ?? "approved")}, ${r.verified ? 1 : 0}, NULL, ${q(daysAgo(r.daysAgo))});`,
  );
}

// ── Orders ──
let orderItemSeq = 0;
for (const o of orders) {
  const placedAt = daysAgo(o.daysAgo, 9 + (o.daysAgo % 8));

  const resolved = o.lines.map((l) => {
    const v = variantIndex.get(l.variantKey);
    if (!v) throw new Error(`${o.id}: unknown variant '${l.variantKey}'`);
    return { v, qty: l.qty, lineSubtotal: v.priceSatang * l.qty };
  });

  const subtotal = resolved.reduce((s, l) => s + l.lineSubtotal, 0);
  const shipping = o.shippingSatang ?? 0;

  // Discount amount: explicit override, else derived from the code.
  let discount = o.discountSatang ?? 0;
  if (!o.discountSatang && o.discountId) {
    const d = discounts.find((x) => x.id === o.discountId);
    if (d?.kind === "percent")
      discount = Math.round((subtotal * (d.valuePercent ?? 0)) / 100);
    else if (d?.kind === "fixed_satang")
      discount = Math.min(d.valueSatang ?? 0, subtotal);
    else if (d?.kind === "free_shipping") discount = shipping;
  }

  const taxable = Math.max(0, subtotal - discount);
  const tax = Math.round(taxable * VAT_RATE);
  const total = taxable + shipping + tax;

  const paid = o.financial !== "pending" && o.financial !== "cancelled";
  const legacy = deriveLegacyStatus(o.financial, o.fulfillment);
  const isPos = o.channel === "tonbab_pos";
  const refundedAt =
    o.financial === "refunded" ? daysAgo(Math.max(0, o.daysAgo - 2)) : null;

  const address = JSON.stringify({
    name: o.email.split("@")[0].replace(/[._]/g, " "),
    line1: "128 Sukhumvit Soi 26",
    city: o.city ?? "Bangkok",
    postal_code: "10110",
    country_code: "TH",
    phone: "+66 2 000 0000",
  });

  lines.push(
    `INSERT OR REPLACE INTO shop_orders (id, order_number, user_id, email, status, financial_status, fulfillment_status, return_status, channel, provider_name, provider_charge_id, subtotal_satang, shipping_satang, tax_satang, tax_included_satang, tax_mode, discount_satang, total_satang, shipping_address_json, billing_address_json, discount_code_snapshot, created_at, updated_at, paid_at, fulfilled_at, delivered_at, refunded_at, cancelled_at, external_source, external_id) VALUES (` +
      `${q(o.id)}, ${q(o.number)}, NULL, ${q(o.email)}, ${q(legacy)}, ${q(o.financial)}, ${q(o.fulfillment)}, NULL, ` +
      `${q(o.channel ?? "online_store")}, ${nul(o.providerName ?? (paid ? "beam" : null))}, ` +
      `${nul(paid ? `seed_charge_${o.id}` : null)}, ` +
      `${subtotal}, ${shipping}, ${tax}, 0, 'exclusive', ${discount}, ${total}, ` +
      `${q(address)}, ${q(address)}, ${nul(o.discountCode ?? null)}, ` +
      `${q(placedAt)}, ${q(placedAt)}, ` +
      `${nul(paid ? placedAt : null)}, ` +
      `${nul(o.fulfillment !== "unfulfilled" ? daysAgo(Math.max(0, o.daysAgo - 1)) : null)}, ` +
      `${nul(o.fulfillment === "delivered" ? daysAgo(Math.max(0, o.daysAgo - 3)) : null)}, ` +
      `${nul(refundedAt)}, ` +
      `${nul(o.financial === "cancelled" ? daysAgo(Math.max(0, o.daysAgo - 1)) : null)}, ` +
      `${nul(isPos ? "tonbab" : null)}, ${nul(isPos ? `TB-${o.number.slice(-5)}` : null)});`,
  );

  // Line items — discount allocated proportionally to line subtotal,
  // with the rounding remainder pushed onto the last line so the
  // allocations sum exactly to shop_orders.discount_satang.
  let allocated = 0;
  resolved.forEach((l, i) => {
    const last = i === resolved.length - 1;
    const share = last
      ? discount - allocated
      : Math.round((discount * l.lineSubtotal) / (subtotal || 1));
    allocated += share;
    const lineTax = Math.round((l.lineSubtotal - share) * VAT_RATE);
    lines.push(
      `INSERT OR REPLACE INTO shop_order_items (id, order_id, variant_id, quantity, title_snapshot, sku_snapshot, price_snapshot_satang, line_subtotal_satang, line_tax_satang, discount_allocated_satang) VALUES (` +
        `${q(`seed_oi_${String(++orderItemSeq).padStart(3, "0")}`)}, ${q(o.id)}, ${q(l.v.id)}, ${l.qty}, ` +
        `${q(`${products.find((p) => p.id === l.v.productId)!.titleEn} — ${l.v.title}`)}, ${q(l.v.sku)}, ` +
        `${l.v.priceSatang}, ${l.lineSubtotal}, ${lineTax}, ${share});`,
    );
  });

  // Refunds — append-only ledger rows, NEGATIVE amounts (matching
  // recordRefund() in order-service.ts). financial_status above is
  // already the ledger-derived projection.
  const refundRows = [
    ...(o.refunds ?? []),
    ...(o.refundFull ? [{ ...o.refundFull, amount: total }] : []),
  ];
  refundRows.forEach((r, i) => {
    lines.push(
      `INSERT OR REPLACE INTO shop_order_adjustments (id, order_id, kind, amount_satang, reason, created_by, created_at, provider_refund_id, idempotency_key) VALUES (` +
        `${q(`seed_adj_${o.id}_${i + 1}`)}, ${q(o.id)}, ${q(r.kind)}, ${-Math.abs(r.amount)}, ${q(r.reason)}, ` +
        `'seed@example.com', ${q(daysAgo(Math.max(0, o.daysAgo - 2)))}, ${q(`seed_refund_${o.id}_${i + 1}`)}, ${q(`seed:refund:${o.id}:${i + 1}`)});`,
    );
  });

  // Discount redemption audit row so per-customer caps and the
  // discount report have something to count.
  if (o.discountId && discount > 0 && paid) {
    lines.push(
      `INSERT OR REPLACE INTO shop_discount_redemptions (discount_id, order_id, user_id, user_email, amount_satang, redeemed_at) VALUES (` +
        `${q(o.discountId)}, ${q(o.id)}, NULL, ${q(o.email)}, ${discount}, ${q(placedAt)});`,
    );
  }
}

// ─── Write + apply ──────────────────────────────────────────

// NOT drizzle/ — the integration test harness replays every *.sql in the
// migrations directory, so a seed file dropped there is applied as if it
// were a migration and silently shifts every fixture count in the suite
// (27 failures the first time this ran). Generated SQL is build output;
// keep it out of the migration chain.
const outDir = join(process.cwd(), ".seed");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "seed-shop-demo.sql");
writeFileSync(outFile, lines.join("\n") + "\n");

const variantCount = products.reduce((s, p) => s + p.variants.length, 0);
console.log(`[seed-shop-demo] wrote ${outFile} (${lines.length} statements)`);
console.log(
  `[seed-shop-demo] applying to ${remote ? "REMOTE" : "LOCAL"} D1 (${dbName})…`,
);

try {
  execSync(`npx wrangler d1 execute ${dbName} ${target} --file=${outFile}`, {
    stdio: "inherit",
  });
  console.log(
    `[seed-shop-demo] done — ${products.length} products, ${variantCount} variants, ` +
      `${collections.length} collections, ${reviews.length} reviews, ${orders.length} orders, ` +
      `${discounts.length} discounts.`,
  );
} catch (err) {
  console.error(
    "[seed-shop-demo] failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
}
