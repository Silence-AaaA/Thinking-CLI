import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the logger before importing WorkingMemory
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import type { Finding, MemorySource, WorkingMemorySnapshot } from "../working-memory.js";
import { WorkingMemory } from "../working-memory.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const src: MemorySource = { kind: "tool", toolName: "grep", filePath: "src/foo.ts" };
const src2: MemorySource = { kind: "observation", toolName: "read_file", filePath: "src/bar.ts" };
const userSrc: MemorySource = { kind: "user" };

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    content: "test finding",
    source: src,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("WorkingMemory", () => {
  let wm: WorkingMemory;

  beforeEach(() => {
    wm = new WorkingMemory();
  });

  // ── Constructor & Config ─────────────────────────────────────────────────

  describe("constructor", () => {
    it("should use default config when none provided", () => {
      expect(wm.version).toBe(0);
    });

    it("should merge partial config with defaults", () => {
      const custom = new WorkingMemory({ maxFindings: 5 });
      // add 6 findings, only 5 should remain
      for (let i = 0; i < 6; i++) {
        custom.addFinding(makeInput({ content: `finding-${i}` }));
      }
      expect(custom.snapshot().findings.length).toBe(5);
    });
  });

  // ── setGoal / setCurrentStep ─────────────────────────────────────────────

  describe("setGoal / setCurrentStep", () => {
    it("setGoal should update snapshot and bump version", () => {
      wm.setGoal("fix bug");
      expect(wm.snapshot().currentGoal).toBe("fix bug");
      expect(wm.version).toBe(1);
    });

    it("setCurrentStep should update snapshot without bumping version", () => {
      wm.setCurrentStep(42);
      expect(wm.snapshot().currentStep).toBe(42);
      expect(wm.version).toBe(0);
    });
  });

  // ── addFinding ───────────────────────────────────────────────────────────

  describe("addFinding", () => {
    it("should add a finding with defaults (medium importance)", () => {
      const f = wm.addFinding(makeInput());
      expect(f.content).toBe("test finding");
      expect(f.importance).toBe("medium");
      expect(f.confidence).toBeCloseTo(0.78);
      expect(f.strength).toBe(10);
      expect(f.id).toMatch(/^wm_/);
      expect(f.lastSeenStep).toBe(0);
    });

    it("should respect low importance defaults", () => {
      const f = wm.addFinding(makeInput({ importance: "low" }));
      expect(f.confidence).toBeCloseTo(0.6);
      expect(f.strength).toBe(6);
    });

    it("should respect high importance defaults", () => {
      const f = wm.addFinding(makeInput({ importance: "high" }));
      expect(f.confidence).toBeCloseTo(0.9);
      expect(f.strength).toBe(14);
    });

    it("should clamp confidence to [0, 1]", () => {
      const f = wm.addFinding(makeInput({ confidence: -0.5 }));
      expect(f.confidence).toBe(0);
      const f2 = wm.addFinding(makeInput({ confidence: 1.5 }));
      expect(f2.confidence).toBe(1);
    });

    it("should clamp strength to [minStrength, maxStrength]", () => {
      const f = wm.addFinding(makeInput({ strength: -100 }));
      expect(f.strength).toBe(0);
      const f2 = wm.addFinding(makeInput({ strength: 999 }));
      expect(f2.strength).toBe(20);
    });

    it("should truncate content to maxFindingLength", () => {
      const longContent = "x".repeat(500);
      const f = wm.addFinding(makeInput({ content: longContent }));
      expect(f.content.length).toBe(240);
    });

    it("should bump version", () => {
      const v0 = wm.version;
      wm.addFinding(makeInput());
      expect(wm.version).toBe(v0 + 1);
    });

    it("should merge with existing finding when replaceKey matches a tag", () => {
      const f1 = wm.addFinding(makeInput({ tags: ["key-a"], strength: 5 }));
      expect(wm.snapshot().findings.length).toBe(1);

      const f2 = wm.addFinding(
        makeInput({ content: "updated", tags: ["key-a", "extra"], replaceKey: "key-a", strength: 3 }),
      );
      expect(wm.snapshot().findings.length).toBe(1); // merged, not duplicated
      expect(f2.content).toBe("updated");
      expect(f2.strength).toBe(7); // max(5,3) + 2
      expect(f2.tags).toContain("key-a");
      expect(f2.tags).toContain("extra");
    });

    it("should add new finding when replaceKey does not match", () => {
      wm.addFinding(makeInput({ tags: ["key-a"] }));
      wm.addFinding(makeInput({ replaceKey: "key-b" }));
      expect(wm.snapshot().findings.length).toBe(2);
    });
  });

  // ── tickStep (decay) ────────────────────────────────────────────────────

  describe("tickStep", () => {
    it("should decay all findings by decayPerStep", () => {
      const f = wm.addFinding(makeInput({ strength: 10 }));
      wm.tickStep(1);
      const snap = wm.snapshot();
      expect(snap.findings[0].strength).toBe(9); // 10 - 1
      expect(snap.currentStep).toBe(1);
    });

    it("should remove findings whose strength drops to minStrength (unless high)", () => {
      wm.addFinding(makeInput({ strength: 1, importance: "low" }));
      wm.tickStep();
      expect(wm.snapshot().findings.length).toBe(0);
    });

    it("should keep high-importance findings even at minStrength", () => {
      wm.addFinding(makeInput({ strength: 1, importance: "high" }));
      wm.tickStep();
      // high importance findings survive even when strength == minStrength (0)
      expect(wm.snapshot().findings.length).toBe(1);
    });

    it("should not decay below minStrength", () => {
      wm.addFinding(makeInput({ strength: 0 }));
      wm.tickStep();
      // strength was 0, decay would make it -1, clamped to 0, low importance → removed
      expect(wm.snapshot().findings.length).toBe(0);
    });

    it("should use current step when argument is undefined", () => {
      wm.setCurrentStep(5);
      wm.addFinding(makeInput());
      wm.tickStep();
      expect(wm.snapshot().currentStep).toBe(5);
    });
  });

  // ── reinforceByFile / demoteByFile ───────────────────────────────────────

  describe("reinforceByFile", () => {
    it("should boost strength for findings matching source.filePath", () => {
      wm.addFinding(makeInput({ strength: 5, source: src }));
      wm.reinforceByFile("src/foo.ts", 3);
      expect(wm.snapshot().findings[0].strength).toBe(8);
    });

    it("should boost strength for findings matching file field", () => {
      wm.addFinding(makeInput({ strength: 5, file: "src/foo.ts" }));
      wm.reinforceByFile("src/foo.ts", 3);
      expect(wm.snapshot().findings[0].strength).toBe(8);
    });

    it("should cap at maxStrength", () => {
      wm.addFinding(makeInput({ strength: 19 }));
      wm.reinforceByFile(src.filePath!, 5);
      expect(wm.snapshot().findings[0].strength).toBe(20);
    });

    it("should not affect unrelated findings", () => {
      wm.addFinding(makeInput({ strength: 5 }));
      wm.reinforceByFile("src/other.ts");
      expect(wm.snapshot().findings[0].strength).toBe(5);
    });
  });

  describe("demoteByFile", () => {
    it("should reduce strength for matching findings", () => {
      wm.addFinding(makeInput({ strength: 10 }));
      wm.demoteByFile("src/foo.ts", 3);
      expect(wm.snapshot().findings[0].strength).toBe(7);
    });

    it("should not go below minStrength", () => {
      wm.addFinding(makeInput({ strength: 1 }));
      wm.demoteByFile("src/foo.ts", 5);
      expect(wm.snapshot().findings[0].strength).toBe(0);
    });
  });

  // ── addActiveFile ───────────────────────────────────────────────────────

  describe("addActiveFile", () => {
    it("should add a file to active files", () => {
      wm.addActiveFile("src/foo.ts");
      expect(wm.snapshot().activeFiles).toContain("src/foo.ts");
    });

    it("should not duplicate if same file added twice", () => {
      wm.addActiveFile("src/foo.ts");
      wm.addActiveFile("src/foo.ts");
      expect(wm.snapshot().activeFiles).toEqual(["src/foo.ts"]);
    });

    it("should evict oldest file when exceeding maxTrackedFiles", () => {
      const small = new WorkingMemory({ maxTrackedFiles: 2 });
      small.addActiveFile("a.ts");
      small.addActiveFile("b.ts");
      small.addActiveFile("c.ts"); // should evict a.ts
      const files = small.snapshot().activeFiles;
      expect(files).not.toContain("a.ts");
      expect(files).toContain("b.ts");
      expect(files).toContain("c.ts");
    });
  });

  // ── addError ────────────────────────────────────────────────────────────

  describe("addError", () => {
    it("should store errors", () => {
      wm.addError("something went wrong");
      expect(wm.snapshot().recentErrors).toContain("something went wrong");
      expect(wm.version).toBe(1);
    });

    it("should keep at most 5 errors", () => {
      for (let i = 0; i < 7; i++) wm.addError(`err-${i}`);
      const errors = wm.snapshot().recentErrors;
      expect(errors.length).toBe(5);
      expect(errors).not.toContain("err-0");
      expect(errors).not.toContain("err-1");
      expect(errors).toContain("err-6");
    });

    it("should truncate long error messages", () => {
      const long = "e".repeat(500);
      wm.addError(long);
      expect(wm.snapshot().recentErrors[0].length).toBe(240);
    });
  });

  // ── addDecision ─────────────────────────────────────────────────────────

  describe("addDecision", () => {
    it("should store decisions", () => {
      wm.addDecision("use approach A");
      expect(wm.snapshot().decisions).toContain("use approach A");
    });

    it("should keep at most 10 decisions", () => {
      for (let i = 0; i < 12; i++) wm.addDecision(`d-${i}`);
      const decisions = wm.snapshot().decisions;
      expect(decisions.length).toBe(10);
      expect(decisions).not.toContain("d-0");
      expect(decisions).not.toContain("d-1");
      expect(decisions).toContain("d-11");
    });
  });

  // ── snapshot / loadSnapshot ─────────────────────────────────────────────

  describe("snapshot / loadSnapshot", () => {
    it("should produce a deep copy of the state", () => {
      wm.setGoal("goal");
      wm.setCurrentStep(3);
      wm.addFinding(makeInput({ tags: ["t1"] }));
      wm.addActiveFile("a.ts");
      wm.addError("err");
      wm.addDecision("dec");

      const snap = wm.snapshot();
      // Mutating the snapshot should not affect the working memory
      snap.findings[0].content = "mutated";
      snap.activeFiles.push("mutated.ts");
      snap.recentErrors.push("mutated");
      snap.decisions.push("mutated");

      const snap2 = wm.snapshot();
      expect(snap2.findings[0].content).toBe("test finding");
      expect(snap2.activeFiles).not.toContain("mutated.ts");
      expect(snap2.recentErrors).not.toContain("mutated");
      expect(snap2.decisions).not.toContain("mutated");
    });

    it("should round-trip through loadSnapshot", () => {
      wm.setGoal("my goal");
      wm.setCurrentStep(7);
      wm.addFinding(makeInput({ importance: "high", tags: ["tag1"] }));
      wm.addActiveFile("x.ts");
      wm.addError("an error");
      wm.addDecision("a decision");

      const snap = wm.snapshot();

      const wm2 = new WorkingMemory();
      wm2.loadSnapshot(snap);
      const snap2 = wm2.snapshot();

      expect(snap2.currentGoal).toBe("my goal");
      expect(snap2.currentStep).toBe(7);
      expect(snap2.findings.length).toBe(1);
      expect(snap2.findings[0].importance).toBe("high");
      expect(snap2.findings[0].tags).toEqual(["tag1"]);
      expect(snap2.activeFiles).toEqual(["x.ts"]);
      expect(snap2.recentErrors).toEqual(["an error"]);
      expect(snap2.decisions).toEqual(["a decision"]);
      expect(snap2.version).toBe(snap.version);
    });
  });

  // ── evictOverflow (via maxFindings) ─────────────────────────────────────

  describe("evictOverflow", () => {
    it("should evict lowest-priority findings when exceeding maxFindings", () => {
      const small = new WorkingMemory({ maxFindings: 3 });
      small.addFinding(makeInput({ content: "low-1", importance: "low", strength: 2 }));
      small.addFinding(makeInput({ content: "med-1", importance: "medium", strength: 8 }));
      small.addFinding(makeInput({ content: "high-1", importance: "high", strength: 14 }));
      small.addFinding(makeInput({ content: "low-2", importance: "low", strength: 1 }));

      const contents = small.snapshot().findings.map((f) => f.content);
      expect(contents).toContain("high-1");
      expect(contents).toContain("med-1");
      expect(contents.length).toBe(3);
      // the weakest low should be evicted
      expect(contents).not.toContain("low-2");
    });
  });

  // ── formatForLLM ────────────────────────────────────────────────────────

  describe("formatForLLM", () => {
    it("should include goal, active files, findings, errors, and decisions", () => {
      wm.setGoal("test goal");
      wm.setCurrentStep(2);
      wm.addActiveFile("src/main.ts");
      wm.addFinding(makeInput({ importance: "high", content: "important thing" }));
      wm.addError("oops");
      wm.addDecision("do X");

      const output = wm.formatForLLM();
      expect(output).toContain("## Working Memory");
      expect(output).toContain("test goal");
      expect(output).toContain("src/main.ts");
      expect(output).toContain("important thing");
      expect(output).toContain("oops");
      expect(output).toContain("do X");
    });

    it("should format findings with importance, strength, confidence", () => {
      wm.addFinding(makeInput({ importance: "high", strength: 15, confidence: 0.9 }));
      const output = wm.formatForLLM();
      expect(output).toMatch(/\[high\|str=15\|conf=0\.90\|/);
    });

    it("should return minimal output when empty", () => {
      const output = wm.formatForLLM();
      expect(output).toContain("## Working Memory");
      expect(output).toContain("Version: 0");
    });
  });

  // ── estimateTokens ──────────────────────────────────────────────────────

  describe("estimateTokens", () => {
    it("should return a positive number", () => {
      wm.addFinding(makeInput());
      expect(wm.estimateTokens()).toBeGreaterThan(0);
    });

    it("should return 0 or small number for empty memory", () => {
      const tokens = wm.estimateTokens();
      expect(tokens).toBeGreaterThanOrEqual(0);
      expect(tokens).toBeLessThan(20);
    });
  });

  // ── reset ───────────────────────────────────────────────────────────────

  describe("reset", () => {
    it("should clear all state and reset version to 0", () => {
      wm.setGoal("goal");
      wm.setCurrentStep(5);
      wm.addFinding(makeInput());
      wm.addActiveFile("a.ts");
      wm.addError("err");
      wm.addDecision("dec");

      wm.reset();

      const snap = wm.snapshot();
      expect(snap.currentGoal).toBe("");
      expect(snap.currentStep).toBe(0);
      expect(snap.findings).toEqual([]);
      expect(snap.activeFiles).toEqual([]);
      expect(snap.recentErrors).toEqual([]);
      expect(snap.decisions).toEqual([]);
      expect(snap.version).toBe(0);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("multiple findings from different sources coexist", () => {
      wm.addFinding(makeInput({ source: src }));
      wm.addFinding(makeInput({ source: src2, content: "finding 2" }));
      wm.addFinding(makeInput({ source: userSrc, content: "finding 3" }));
      expect(wm.snapshot().findings.length).toBe(3);
    });

    it("tickStep with no findings should not throw", () => {
      expect(() => wm.tickStep()).not.toThrow();
    });

    it("reinforceByFile with no findings should not throw", () => {
      expect(() => wm.reinforceByFile("nonexistent.ts")).not.toThrow();
    });

    it("demoteByFile with no findings should not throw", () => {
      expect(() => wm.demoteByFile("nonexistent.ts")).not.toThrow();
    });

    it("addFinding with empty content works", () => {
      const f = wm.addFinding(makeInput({ content: "" }));
      expect(f.content).toBe("");
    });

    it("addFinding with no tags works", () => {
      const f = wm.addFinding(makeInput());
      expect(f.tags).toBeUndefined();
    });

    it("version increments correctly across multiple operations", () => {
      const v0 = wm.version;
      wm.setGoal("g"); // +1
      wm.addFinding(makeInput()); // +1
      wm.addError("e"); // +1
      wm.addDecision("d"); // +1
      expect(wm.version).toBe(v0 + 4);
    });
  });
});
