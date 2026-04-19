/**
 * Home feature definitions — drives the "What does your home have?" step
 * in the home profile wizard and determines which services/maintenance
 * templates apply to the household.
 */

export interface HomeFeatureDef {
  key: string;
  label: string;
  labelHi: string;
  labelKn: string;
  group: FeatureGroup;
  /** If true, show a quantity input (e.g., AC count). */
  hasQuantity?: boolean;
  quantityLabel?: string;
  /** Only show this feature for certain home types. */
  homeTypes?: string[];
}

export type FeatureGroup =
  | "cooling_heating"
  | "water"
  | "kitchen"
  | "power"
  | "outdoor"
  | "safety"
  | "appliances";

export const FEATURE_GROUPS: Record<FeatureGroup, { label: string; labelHi: string; labelKn: string }> = {
  cooling_heating: { label: "Cooling & Heating", labelHi: "कूलिंग और हीटिंग", labelKn: "ತಂಪಾಗಿಸುವಿಕೆ ಮತ್ತು ತಾಪನ" },
  water: { label: "Water", labelHi: "पानी", labelKn: "ನೀರು" },
  kitchen: { label: "Kitchen", labelHi: "रसोई", labelKn: "ಅಡುಗೆಮನೆ" },
  power: { label: "Power & Solar", labelHi: "बिजली और सोलर", labelKn: "ವಿದ್ಯುತ್ ಮತ್ತು ಸೋಲಾರ್" },
  outdoor: { label: "Outdoor & Exterior", labelHi: "बाहरी क्षेत्र", labelKn: "ಹೊರಾಂಗಣ" },
  safety: { label: "Safety & Security", labelHi: "सुरक्षा", labelKn: "ಸುರಕ್ಷತೆ" },
  appliances: { label: "Appliances", labelHi: "उपकरण", labelKn: "ಉಪಕರಣಗಳು" },
};

export const HOME_FEATURES: HomeFeatureDef[] = [
  // Cooling & Heating
  { key: "ac_split", label: "Split AC", labelHi: "स्प्लिट AC", labelKn: "ಸ್ಪ್ಲಿಟ್ AC", group: "cooling_heating", hasQuantity: true, quantityLabel: "Units" },
  { key: "ac_window", label: "Window AC", labelHi: "विंडो AC", labelKn: "ವಿಂಡೋ AC", group: "cooling_heating", hasQuantity: true, quantityLabel: "Units" },
  { key: "geyser_electric", label: "Electric Geyser", labelHi: "इलेक्ट्रिक गीज़र", labelKn: "ಎಲೆಕ್ಟ್ರಿಕ್ ಗೀಸರ್", group: "cooling_heating", hasQuantity: true, quantityLabel: "Units" },
  { key: "geyser_gas", label: "Gas Geyser", labelHi: "गैस गीज़र", labelKn: "ಗ್ಯಾಸ್ ಗೀಸರ್", group: "cooling_heating" },
  { key: "geyser_solar", label: "Solar Water Heater", labelHi: "सोलर वॉटर हीटर", labelKn: "ಸೋಲಾರ್ ವಾಟರ್ ಹೀಟರ್", group: "cooling_heating" },

  // Water
  { key: "water_purifier_ro", label: "RO Water Purifier", labelHi: "RO वॉटर प्यूरीफायर", labelKn: "RO ನೀರು ಶುದ್ಧೀಕರಣ", group: "water" },
  { key: "water_purifier_uv", label: "UV Water Purifier", labelHi: "UV वॉटर प्यूरीफायर", labelKn: "UV ನೀರು ಶುದ್ಧೀಕರಣ", group: "water" },
  { key: "borewell", label: "Borewell", labelHi: "बोरवेल", labelKn: "ಬೋರ್‌ವೆಲ್", group: "water", homeTypes: ["villa", "independent_house"] },
  { key: "water_sump", label: "Water Sump / Tank", labelHi: "पानी की टंकी", labelKn: "ನೀರಿನ ಟ್ಯಾಂಕ್", group: "water" },

  // Kitchen
  { key: "kitchen_chimney", label: "Kitchen Chimney", labelHi: "किचन चिमनी", labelKn: "ಅಡುಗೆಮನೆ ಚಿಮ್ನಿ", group: "kitchen" },
  { key: "lpg_cylinder", label: "LPG Gas Cylinder", labelHi: "LPG गैस सिलेंडर", labelKn: "LPG ಗ್ಯಾಸ್ ಸಿಲಿಂಡರ್", group: "kitchen", hasQuantity: true, quantityLabel: "Cylinders" },
  { key: "piped_gas", label: "Piped Natural Gas (PNG)", labelHi: "पाइप्ड गैस (PNG)", labelKn: "ಪೈಪ್ಡ್ ಗ್ಯಾಸ್ (PNG)", group: "kitchen" },
  { key: "dishwasher", label: "Dishwasher", labelHi: "डिशवॉशर", labelKn: "ಡಿಶ್‌ವಾಶರ್", group: "kitchen" },

  // Power & Solar
  { key: "solar_panels", label: "Solar Panels", labelHi: "सोलर पैनल", labelKn: "ಸೋಲಾರ್ ಪ್ಯಾನಲ್", group: "power" },
  { key: "inverter_ups", label: "Inverter / UPS", labelHi: "इन्वर्टर / UPS", labelKn: "ಇನ್ವರ್ಟರ್ / UPS", group: "power" },
  { key: "generator", label: "Generator", labelHi: "जनरेटर", labelKn: "ಜನರೇಟರ್", group: "power", homeTypes: ["villa", "independent_house"] },

  // Outdoor & Exterior
  { key: "bicycle", label: "Bicycle", labelHi: "साइकिल", labelKn: "ಬೈಸಿಕಲ್", group: "outdoor", hasQuantity: true, quantityLabel: "Bicycles" },
  { key: "garden", label: "Garden / Lawn", labelHi: "बगीचा / लॉन", labelKn: "ತೋಟ / ಲಾನ್", group: "outdoor" },
  { key: "garden_irrigation", label: "Garden Irrigation System", labelHi: "बगीचा सिंचाई प्रणाली", labelKn: "ತೋಟ ನೀರಾವರಿ ವ್ಯವಸ್ಥೆ", group: "outdoor" },
  { key: "swimming_pool", label: "Swimming Pool", labelHi: "स्विमिंग पूल", labelKn: "ಈಜುಕೊಳ", group: "outdoor", homeTypes: ["villa", "villa_with_pool", "independent_house", "penthouse"] },
  { key: "wood_flooring", label: "Wood / Laminate Flooring", labelHi: "लकड़ी / लैमिनेट फ़्लोरिंग", labelKn: "ಮರ / ಲ್ಯಾಮಿನೇಟ್ ಫ್ಲೋರಿಂಗ್", group: "outdoor" },
  { key: "carpet_flooring", label: "Carpet / Area Rugs", labelHi: "कालीन / एरिया रग", labelKn: "ಕಾರ್ಪೆಟ್ / ಏರಿಯಾ ರಗ್", group: "outdoor" },

  // Safety & Security
  { key: "cctv_system", label: "CCTV Cameras", labelHi: "CCTV कैमरा", labelKn: "CCTV ಕ್ಯಾಮೆರಾ", group: "safety", hasQuantity: true, quantityLabel: "Cameras" },
  { key: "elevator", label: "Home Elevator / Lift", labelHi: "होम लिफ्ट", labelKn: "ಹೋಮ್ ಲಿಫ್ಟ್", group: "safety", homeTypes: ["villa", "independent_house", "penthouse"] },
  { key: "fire_extinguisher", label: "Fire Extinguisher", labelHi: "अग्निशामक", labelKn: "ಅಗ್ನಿಶಾಮಕ", group: "safety" },

  // Appliances
  { key: "washing_machine", label: "Washing Machine", labelHi: "वॉशिंग मशीन", labelKn: "ವಾಷಿಂಗ್ ಮಷೀನ್", group: "appliances" },
  { key: "refrigerator", label: "Refrigerator", labelHi: "रेफ्रिजरेटर", labelKn: "ರೆಫ್ರಿಜಿರೇಟರ್", group: "appliances" },
  { key: "microwave", label: "Microwave / OTG", labelHi: "माइक्रोवेव / OTG", labelKn: "ಮೈಕ್ರೋವೇವ್ / OTG", group: "appliances" },
  { key: "vacuum_cleaner", label: "Vacuum Cleaner", labelHi: "वैक्यूम क्लीनर", labelKn: "ವ್ಯಾಕ್ಯೂಮ್ ಕ್ಲೀನರ್", group: "appliances" },
];

/** Get features applicable to a given home type. */
export function featuresForHomeType(homeType: string): HomeFeatureDef[] {
  return HOME_FEATURES.filter(
    (f) => !f.homeTypes || f.homeTypes.includes(homeType),
  );
}

/** Get feature label in the given language. */
export function featureLabel(feature: HomeFeatureDef, lang: string): string {
  if (lang === "hi") return feature.labelHi;
  if (lang === "kn") return feature.labelKn;
  return feature.label;
}

/** Get group label in the given language. */
export function groupLabel(group: FeatureGroup, lang: string): string {
  const g = FEATURE_GROUPS[group];
  if (lang === "hi") return g.labelHi;
  if (lang === "kn") return g.labelKn;
  return g.label;
}
