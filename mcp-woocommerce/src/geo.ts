type Product = {
  id: number; name: string; permalink?: string; status?: string; type?: string;
  description?: string; short_description?: string; price?: string; regular_price?: string;
  stock_status?: string; categories?: { name?: string }[]; tags?: { name?: string }[];
  attributes?: { name?: string; options?: string[] }[]; images?: { alt?: string; src?: string }[];
};

export type GeoCheck = { key: string; label: string; weight: number; passed: boolean; detail: string; recommendation?: string };

const plainText = (html = "") => html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
  .replace(/\s+/g, " ").trim();

export function assessGeoReadiness(product: Product) {
  const title = plainText(product.name ?? "");
  const description = plainText(`${product.short_description ?? ""} ${product.description ?? ""}`);
  const categories = product.categories ?? [];
  const tags = product.tags ?? [];
  const attributes = (product.attributes ?? []).filter((a) => a.name && a.options?.some((v) => v.trim()));
  const images = product.images ?? [];
  const price = product.price || product.regular_price;
  const checks: GeoCheck[] = [
    {
      key: "title", label: "Descriptive product name", weight: 20,
      passed: title.length >= 20 && title.split(/\s+/).length >= 3,
      detail: title.length >= 20 ? "The name gives an agent useful terms to match." : "The product name is short or generic.",
      recommendation: "Name the product with its type and distinguishing details, such as material, model, size, or intended use.",
    },
    {
      key: "description", label: "Useful product description", weight: 25,
      passed: description.length >= 240,
      detail: `${description.length} readable characters across short and full descriptions.`,
      recommendation: "Add a factual description covering what it is, who it suits, key benefits, dimensions or materials, and relevant limitations.",
    },
    {
      key: "taxonomy", label: "Category or product tags", weight: 10,
      passed: categories.length > 0 || tags.length > 0,
      detail: `${categories.length} categories and ${tags.length} tags are set.`,
      recommendation: "Assign a specific WooCommerce category and a few accurate, shopper-language tags.",
    },
    {
      key: "attributes", label: "Structured product attributes", weight: 15,
      passed: attributes.length >= 2,
      detail: `${attributes.length} populated attributes are available as structured fields.`,
      recommendation: "Add structured attributes such as size, material, compatibility, ingredients, or model. Use only facts supplied by the merchant.",
    },
    {
      key: "images", label: "Image descriptions", weight: 10,
      passed: images.length > 0 && images.every((image) => !!image.alt?.trim()),
      detail: images.length === 0 ? "No product images are listed." : `${images.filter((image) => !!image.alt?.trim()).length} of ${images.length} images have alt text.`,
      recommendation: "Add concise, accurate alt text describing each image; do not use keyword lists.",
    },
    {
      key: "price", label: "Price provided", weight: 10,
      passed: !!price && Number.isFinite(Number(price)) && Number(price) > 0,
      detail: price ? `A price is present (${price}). Currency is the store currency.` : "No usable price is set.",
      recommendation: "Set a valid product price and confirm the store currency is configured correctly.",
    },
    {
      key: "availability", label: "Availability is explicit", weight: 10,
      passed: ["instock", "outofstock", "onbackorder"].includes(product.stock_status ?? "") && product.status === "publish",
      detail: product.status === "publish" && product.stock_status ? `Published; stock status is ${product.stock_status}.` : "Publication or stock status is not explicit.",
      recommendation: "Publish the product and keep its WooCommerce stock status accurate.",
    },
  ];
  const score = Math.round(checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0));
  return {
    id: product.id, name: product.name, permalink: product.permalink ?? null,
    status: product.status ?? "unknown", score, checks,
    structured_record: {
      id: product.id,
      title: title || null,
      url: product.permalink ?? null,
      description: description || null,
      categories: categories.map((category) => category.name).filter(Boolean),
      tags: tags.map((tag) => tag.name).filter(Boolean),
      attributes: Object.fromEntries(attributes.map((attribute) => [attribute.name!, attribute.options!.filter(Boolean)])),
      price: price && Number.isFinite(Number(price)) ? Number(price) : null,
      availability: product.stock_status ?? null,
      images: images.map((image) => ({ url: image.src ?? null, alt: image.alt?.trim() || null })),
    },
    recommendations: checks.filter((check) => !check.passed).map((check) => check.recommendation!),
  };
}
