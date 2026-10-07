const modules = import.meta.glob("../features/*/index.ts", { eager: true });

export const discoveredFeatureCount = Object.keys(modules).length;
