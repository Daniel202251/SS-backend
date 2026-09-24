import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const documents = ["README.md", "DEVELOPMENT.md", "CONTRIBUTING.md"];
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("developer documentation", () => {
  it.each(documents)("contains valid UTF-8 without replacement characters: %s", (document) => {
    const content = fs.readFileSync(path.join(root, document), "utf8");
    expect(content).not.toContain("�");
    expect(content.trim().length).toBeGreaterThan(100);
  });

  it.each(documents)("references existing local files: %s", (document) => {
    const content = fs.readFileSync(path.join(root, document), "utf8");
    const links = [...content.matchAll(/\[[^\]]+\]\((?!https?:|mailto:)([^)#]+)(?:#[^)]+)?\)/g)];

    for (const [, target] of links) {
      expect(fs.existsSync(path.resolve(root, path.dirname(document), target))).toBe(true);
    }
  });

  it.each(documents)("only documents npm scripts that exist: %s", (document) => {
    const content = fs.readFileSync(path.join(root, document), "utf8");
    const scripts = [...content.matchAll(/npm run ([a-z0-9:-]+)/gi)].map((match) => match[1]);

    for (const script of scripts) {
      expect(packageJson.scripts).toHaveProperty(script);
    }
  });
});
