export type Product = { name: string; category: string; price: number; units: number; stock: number; trend: number };
export const categoryTone: Record<string, string> = { Grocery: "amber", Dairy: "sky", Beverages: "cyan", Snacks: "lime", Household: "vio", Bakery: "amber" };
export const products: Product[] = [
  { name: "Gehu Gold Atta 5kg", category: "Grocery", price: 240, units: 142, stock: 86, trend: 9 },
  { name: "Nandini Milk 1L", category: "Dairy", price: 66, units: 410, stock: 120, trend: 4 },
  { name: "Sagar Rice Ponni 10kg", category: "Grocery", price: 590, units: 38, stock: 44, trend: 7 },
  { name: "Fizzo Cola 750ml", category: "Beverages", price: 40, units: 188, stock: 62, trend: -3 },
  { name: "Crunchee Marie 250g", category: "Snacks", price: 30, units: 220, stock: 140, trend: 6 },
  { name: "Kavya Sunflower Oil 1L", category: "Grocery", price: 165, units: 36, stock: 3, trend: 2 },
  { name: "Sudha Detergent 1kg", category: "Household", price: 95, units: 54, stock: 38, trend: -1 },
  { name: "Nandini Curd 400g", category: "Dairy", price: 35, units: 160, stock: 6, trend: 3 },
  { name: "Bake House Bread", category: "Bakery", price: 45, units: 90, stock: 8, trend: 1 },
  { name: "Paneer Fresh 200g", category: "Dairy", price: 90, units: 70, stock: 12, trend: 5 },
  { name: "Eggs Tray 30", category: "Dairy", price: 210, units: 48, stock: 5, trend: -2 },
  { name: "Toor Dal 1kg", category: "Grocery", price: 160, units: 64, stock: 9, trend: 4 },
];
export const lowStock = (p: Product) => p.stock < 15;
export const orders = [
  { id: 4821, time: "10:42", items: 6, total: 1240, method: "UPI", status: "Paid" },
  { id: 4820, time: "10:08", items: 4, total: 860, method: "Cash", status: "Paid" },
  { id: 4819, time: "09:47", items: 11, total: 2310, method: "Card", status: "Paid" },
  { id: 4818, time: "09:30", items: 2, total: 180, method: "UPI", status: "Refunded" },
  { id: 4817, time: "09:12", items: 8, total: 1575, method: "UPI", status: "Paid" },
  { id: 4816, time: "08:55", items: 3, total: 420, method: "Cash", status: "Paid" },
];
export const suppliers = [
  { name: "Nandini Dairy Co-op", items: "Milk, Curd, Paneer", phone: "+91 98400 11223", due: 18400 },
  { name: "Sri Balaji Traders", items: "Atta, Rice, Dal, Oil", phone: "+91 98410 33445", due: 42750 },
  { name: "Fizzo Beverages", items: "Soft drinks", phone: "+91 99620 55667", due: 0 },
  { name: "Bake House", items: "Bread, Buns", phone: "+91 90030 77889", due: 3200 },
];
export const inr = (n: number) => "₹" + n.toLocaleString("en-IN");

export function answer(q: string): string {
  const s = q.toLowerCase();
  if (/reorder|restock|low|stock/.test(s)) {
    const l = products.filter(lowStock).map((p) => `${p.name} (${p.stock} left)`);
    return `Reorder these this week: ${l.join(", ")}. Kavya Sunflower Oil is the most urgent — it sells ~36 a fortnight and only 3 are left.`;
  }
  if (/sunday|dip|profit/.test(s)) return "Sunday profit dipped mainly because footfall was 22% lower and more sales came from low-margin staples (atta, rice). Fizzo Cola also fell 3%. A small weekend snack + beverage combo could lift margins.";
  if (/dairy|offer|time/.test(s)) return "Dairy sells best 7–9 AM and 6–8 PM. Run the dairy offer in the evening slot — Curd and Paneer batches expire in 1–5 days, so this also cuts wastage.";
  if (/best|top|sell/.test(s)) { const t = [...products].sort((a, b) => b.units * b.price - a.units * a.price).slice(0, 3); return "Top sellers by revenue: " + t.map((p) => `${p.name} (${inr(p.units * p.price)})`).join(", ") + "."; }
  if (/revenue|sales|today/.test(s)) return "Today's revenue is ₹1,28,450 from 348 orders (avg ₹369), 86% of your ₹1.5L target. This month is up 18.6% vs April.";
  if (/expir/.test(s)) return "Expiring soon: Nandini Curd 400g (1 day), Bake House Bread (2 days), Paneer Fresh 200g (5 days).";
  return "I can help with stock to reorder, top sellers, revenue, expiring items, profit changes and offer timing. Try one of the suggested questions.";
}
