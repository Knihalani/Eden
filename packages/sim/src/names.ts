/**
 * Name and vocabulary banks for the simulated world. Chosen to stress what real address books do to entity
 * matching: shared first names (two Sams, two Danas), nicknames (Alexander/Alex), names that are also words (Will,
 * Rose, Bill, Mark, May), very short names (Al, Bo, Jo), and names with accents or non-Latin letters.
 */

/** [first, last, nickname?]. Order matters only for determinism. */
export const WORK_PEOPLE: [string, string, string?][] = [
  ["Sam", "Ortiz"],
  ["Sam", "Patel"],
  ["Dana", "Lee"],
  ["Dana", "Whitfield"],
  ["Priya", "Raman"],
  ["Marcus", "Webb"],
  ["Alexander", "Novak", "Alex"],
  ["Katherine", "Okafor", "Kate"],
  ["Robert", "Haddad", "Bob"],
  ["Will", "Thornton"],
  ["Rose", "Kimura"],
  ["Bill", "Lumbergh"],
  ["Mark", "Adeyemi"],
  ["May", "Lindqvist"],
  ["Al", "Chen"],
  ["Bo", "Jensen"],
  ["Jo", "Mensah"],
  ["Zoë", "Müller"],
  ["José", "García"],
  ["Søren", "Kierkegaard"],
  ["Łukasz", "Nowak"],
  ["Aiko", "Tanaka"],
  ["Fatima", "Haddad"],
  ["Ingrid", "Berg"],
  ["Raj", "Malhotra"],
  ["Olu", "Adebayo"],
  ["Elena", "Ivanova"],
  ["Yusuf", "Demir"],
  ["Mia", "Rossi"],
  ["Hana", "Kim"],
  ["Kofi", "Boateng"],
  ["Tomás", "Silva"],
  ["Lars", "Nilsen"],
  ["Chen", "Wei"],
  ["Mateo", "Fernández"],
  ["Nadia", "Petrova"],
  ["Ethan", "Brooks"],
  ["Grace", "Liu"],
  ["Daniel", "Cohen", "Dan"],
  ["Jennifer", "Walsh", "Jen"],
  ["Michael", "O'Brien", "Mike"],
  ["Christopher", "Hall", "Chris"],
  ["Rebecca", "Stone", "Becky"],
  ["Vikram", "Iyer"],
  ["Amara", "Okonkwo"],
  ["Oskar", "Lindgren"],
  ["Lucía", "Romero"],
  ["Ahmed", "Hassan"],
];

/** People in the user's personal life, with the role the user calls them by. */
export const PERSONAL_PEOPLE: { first: string; last: string; role: string; relation: string }[] = [
  { first: "Steve", last: "Hargreaves", role: "landlord", relation: "service" },
  { first: "Ngozi", last: "Okafor", role: "dentist", relation: "service" },
  { first: "Tom", last: "Bradley", role: "personal trainer", relation: "service" },
  { first: "Ellie", last: "Carter", role: "sister", relation: "family" },
  { first: "Ruth", last: "Carter", role: "mum", relation: "family" },
  { first: "Jamie", last: "Fox", role: "best friend", relation: "friend" },
  { first: "Leila", last: "Haddad", role: "friend", relation: "friend" },
  { first: "Owen", last: "Price", role: "accountant", relation: "service" },
  { first: "Mrs", last: "Daley", role: "Maya's teacher", relation: "service" },
];

/** [name, domain, industry]. */
export const ORGS: [string, string, string][] = [
  ["Globex", "globex.com", "logistics"],
  ["Initech", "initech.io", "software"],
  ["Umbrella Health", "umbrellahealth.com", "healthcare"],
  ["Hooli", "hooli.xyz", "search"],
  ["Vandelay Industries", "vandelay.co", "import/export"],
  ["Stark Freight", "starkfreight.com", "shipping"],
  ["Wayne Analytics", "wayneanalytics.ai", "analytics"],
  ["Soylent Foods", "soylentfoods.com", "food"],
  ["Cyberdyne", "cyberdyne.systems", "robotics"],
  ["Tyrell Bio", "tyrellbio.com", "biotech"],
  ["Aperture Labs", "aperturelabs.io", "research"],
  ["Pied Piper", "piedpiper.com", "compression"],
];

export const SELF_ORG: [string, string] = ["Northwind", "northwind.co"];

export const PROJECTS: { name: string; key: string; topic: string }[] = [
  { name: "Atlas", key: "OPS", topic: "data migration" },
  { name: "Beacon", key: "WEB", topic: "website relaunch" },
  { name: "Cobalt", key: "BILL", topic: "billing rewrite" },
  { name: "Delta", key: "SEC", topic: "SOC 2 audit" },
];

export const CITIES: { city: string; airport: string; hotel: string }[] = [
  { city: "Berlin", airport: "BER", hotel: "Hotel Adlon" },
  { city: "Lisbon", airport: "LIS", hotel: "Memmo Alfama" },
  { city: "New York", airport: "JFK", hotel: "The Ludlow" },
  { city: "Tokyo", airport: "HND", hotel: "Hotel Okura" },
];

export const RESTAURANTS = ["Dishoom", "Nopi", "Padella", "Barrafina", "Hoppers", "St. John", "Rochelle Canteen"];

export const GIFT_IDEAS = [
  "Ottolenghi cookbooks",
  "a pottery class voucher",
  "noise-cancelling headphones",
  "a first-edition Le Guin",
  "climbing shoes (size 39)",
  "a Le Creuset casserole",
];

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Newsletter and promo senders: noise that shares vocabulary with real work ("pricing", "renewal", "launch"). */
export const NEWSLETTERS: { from: string; domain: string; topics: string[] }[] = [
  { from: "SaaStr Weekly", domain: "saastr.com", topics: ["pricing", "renewal", "churn", "discount", "board"] },
  { from: "Logistics Today", domain: "logisticstoday.com", topics: ["Globex", "freight", "shipping", "contract"] },
  { from: "The Hustle", domain: "thehustle.co", topics: ["launch", "funding", "Hooli", "search", "deal"] },
  { from: "Lenny's Newsletter", domain: "lennysnewsletter.com", topics: ["roadmap", "pricing", "onboarding"] },
  { from: "Skyscanner Deals", domain: "skyscanner.net", topics: ["flight", "Berlin", "Lisbon", "hotel", "Tokyo"] },
  { from: "OpenTable", domain: "opentable.com", topics: ["dinner", "reservation", "Dishoom", "Padella", "table"] },
];
