import { Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, App, normalizePath } from "obsidian";
import { BrushLibrary } from "./brushes";
import { importBrushFile } from "./import";
import { Settings } from "./types";
import { DrawView, FILE_EXT, VIEW_TYPE } from "./view";
import { PencilEmbed } from "./embed";

function defaults(): Settings {
  const dark = document.body.classList.contains("theme-dark");
  return {
    pen: { size: 4, color: dark ? "#ffffff" : "#1e1e1e", opacity: 1, brush: "ink", smoothing: 0 },
    highlighter: { size: 24, color: "#ffe066" },
    eraser: { size: 28, mode: "partial" },
    fingerDraw: false,
    holdStraight: true,
    cardDraw: true,
    ruler: { on: false, angle: 0, follow: true },
    fixedSize: true,
    dots: true,
    brushes: [],
  };
}

export default class PencilCanvasPlugin extends Plugin {
  settings!: Settings;
  lib = new BrushLibrary();
  private saveTimer = 0;

  async onload() {
    const d = defaults();
    const saved = ((await this.loadData()) ?? {}) as Partial<Settings>;
    this.settings = {
      ...d,
      ...saved,
      pen: { ...d.pen, ...saved.pen },
      highlighter: { ...d.highlighter, ...saved.highlighter },
      eraser: { ...d.eraser, ...saved.eraser },
      ruler: { ...d.ruler, ...saved.ruler },
      brushes: Array.isArray(saved.brushes) ? saved.brushes : [],
    };
    this.lib.setUser(this.settings.brushes.slice());

    this.registerView(VIEW_TYPE, (leaf) => new DrawView(leaf, this));
    this.registerExtensions([FILE_EXT], VIEW_TYPE);

    this.registerEmbeds();

    this.addRibbonIcon("pencil", "New drawing", () => this.createDrawing());
    this.addCommand({ id: "new-drawing", name: "New drawing", callback: () => this.createDrawing() });
    this.addCommand({
      id: "toggle-eraser",
      name: "Swap between eraser and last tool",
      checkCallback: (checking) => {
        const v = this.app.workspace.getActiveViewOfType(DrawView);
        if (!v) return false;
        if (!checking) v.toggleEraser();
        return true;
      },
    });
    this.addCommand({
      id: "export-svg",
      name: "Export drawing as SVG",
      checkCallback: (checking) => {
        const v = this.app.workspace.getActiveViewOfType(DrawView);
        if (!v) return false;
        if (!checking) v.exportSvg();
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((i) => i.setTitle("New drawing").setIcon("pencil").onClick(() => this.createDrawing(file)));
        }
      })
    );
    this.addCommand({
      id: "canvas-add-drawing",
      name: "Add a new drawing to this canvas",
      checkCallback: (checking) => {
        const cv = this.activeCanvas();
        if (!cv) return false;
        if (!checking) this.addDrawingToCanvas(cv);
        return true;
      },
    });
    // right-click / long-press a drawing card in Canvas → open it for editing
    this.registerEvent(
      (this.app.workspace as any).on("canvas:node-menu", (menu: any, node: any) => {
        const file = node?.file;
        if (!(file instanceof TFile) || file.extension !== FILE_EXT) return;
        if (node.child instanceof PencilEmbed && !node.canvas?.readonly) {
          menu.addItem((i: any) => i.setSection("open").setTitle("Draw on this card").setIcon("pencil").onClick(() => node.child.startSession()));
        }
        menu.addItem((i: any) => i.setSection("open").setTitle("Open drawing in a tab").setIcon("maximize-2").onClick(() => this.openDrawing(file)));
      })
    );
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  /**
   * Show drawings wherever Obsidian embeds a file: cards in Canvas and ![[drawing.pencil]] in notes.
   * The embed registry is not part of the public API, so every step is guarded.
   */
  private registerEmbeds() {
    const reg = (this.app as any).embedRegistry;
    if (!reg || typeof reg.registerExtension !== "function") return;
    try {
      if (reg.isExtensionRegistered?.(FILE_EXT)) reg.unregisterExtension(FILE_EXT);
      reg.registerExtension(FILE_EXT, (ctx: { containerEl: HTMLElement }, file: TFile) => new PencilEmbed(this, ctx.containerEl, file));
      this.register(() => {
        try {
          reg.unregisterExtension(FILE_EXT);
        } catch {
          /* nothing to undo */
        }
      });
    } catch (e) {
      console.warn("Pencil Canvas: could not register the embed preview", e);
    }
  }

  /** Open a drawing for editing, reusing a tab that already shows it. */
  openDrawing(file: TFile) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof DrawView && leaf.view.file === file) {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        return;
      }
    }
    this.app.workspace.getLeaf("tab").openFile(file);
  }

  private activeCanvas(): any {
    const view = this.app.workspace.getMostRecentLeaf()?.view as any;
    const cv = view?.getViewType?.() === "canvas" ? view.canvas : null;
    return cv && !cv.readonly && typeof cv.createFileNode === "function" ? cv : null;
  }

  private async addDrawingToCanvas(cv: any) {
    const canvasFile: TFile | undefined = cv.view?.file;
    try {
      const file = await this.newDrawingFile(canvasFile?.parent ?? undefined);
      const size = { width: 480, height: 360 };
      const x = typeof cv.x === "number" ? cv.x : 0, y = typeof cv.y === "number" ? cv.y : 0;
      cv.createFileNode({ pos: { x: x - size.width / 2, y: y - size.height / 2 }, size, file, save: true, focus: true });
    } catch (e) {
      new Notice("Pencil Canvas: could not add a drawing to this canvas.");
      console.error(e);
    }
  }

  onunload() {
    window.clearTimeout(this.saveTimer);
  }

  eachView(fn: (v: DrawView) => void) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof DrawView) fn(leaf.view);
    }
  }

  saveSettings() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveData(this.settings), 400);
  }

  persistBrushes() {
    this.settings.brushes = this.lib.user.slice();
    this.saveSettings();
  }

  async createDrawing(folder?: TFolder) {
    const file = await this.newDrawingFile(folder);
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  private async newDrawingFile(folder?: TFolder | null) {
    const parent = folder ?? this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
    const dir = parent.path === "/" ? "" : parent.path + "/";
    const n = new Date();
    const two = (v: number) => String(v).padStart(2, "0");
    const stamp = `${n.getFullYear()}-${two(n.getMonth() + 1)}-${two(n.getDate())} ${two(n.getHours())}.${two(n.getMinutes())}.${two(n.getSeconds())}`;
    let path = normalizePath(`${dir}Drawing ${stamp}.${FILE_EXT}`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}Drawing ${stamp} ${i}.${FILE_EXT}`);
    return this.app.vault.create(path, "");
  }

  /** Import brush files; returns the id of the first imported brush (if any). */
  async importBrushes(files: File[]): Promise<string | null> {
    let first: string | null = null;
    let total = 0;
    let dupes = 0;
    const warnings: string[] = [];
    for (const f of files) {
      try {
        const res = await importBrushFile(f.name, new Uint8Array(await f.arrayBuffer()));
        warnings.push(...res.warnings);
        for (const b of res.brushes) {
          if (!first) first = b.id;
          if (this.lib.add([b])) total++;
          else dupes++;
        }
      } catch (e) {
        warnings.push(`${f.name}: ${(e as Error).message}`);
      }
    }
    if (total) this.persistBrushes();
    const lines = [total ? `Imported ${total} brush${total === 1 ? "" : "es"}.` : dupes ? "Those brushes are already in your library." : "No brushes were imported."];
    if (warnings.length) lines.push(...warnings.slice(0, 4), ...(warnings.length > 4 ? [`…and ${warnings.length - 4} more notes.`] : []));
    new Notice(lines.join("\n"), warnings.length ? 9000 : 4000);
    return first;
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: PencilCanvasPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Draw with finger")
      .setDesc("Off: fingers pan and zoom, only the pencil (or mouse) draws. A finger double-tap swaps to the eraser, a two-finger tap undoes, a three-finger tap redoes.")
      .addToggle((t) =>
        t.setValue(s.fingerDraw).onChange((v) => {
          s.fingerDraw = v;
          this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Erase entire strokes")
      .setDesc("On: touching a stroke with the eraser removes all of it. Off: only the part under the eraser is cut away.")
      .addToggle((t) =>
        t.setValue(s.eraser.mode === "stroke").onChange((v) => {
          s.eraser.mode = v ? "stroke" : "partial";
          this.plugin.saveSettings();
          this.plugin.eachView((view) => view.syncToolbar());
        })
      );
    new Setting(containerEl)
      .setName("Hold to straighten")
      .setDesc("Keep the pen still at the end of a stroke for a moment and it snaps into a straight line that follows the pen until you lift it.")
      .addToggle((t) =>
        t.setValue(s.holdStraight).onChange((v) => {
          s.holdStraight = v;
          this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Pencil draws on Canvas cards")
      .setDesc("In Obsidian Canvas, the pencil draws straight onto a drawing card; move the card with a finger or by its title. Off: double-click the card (or use its menu) before drawing on it.")
      .addToggle((t) =>
        t.setValue(s.cardDraw).onChange((v) => {
          s.cardDraw = v;
          this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Keep pen size fixed on the canvas")
      .setDesc("On: a size-4 line is the same thickness as every other size-4 line, however far you are zoomed in. Off: the line is always that many pixels on screen, so zooming in draws finer lines.")
      .addToggle((t) =>
        t.setValue(s.fixedSize).onChange((v) => {
          s.fixedSize = v;
          this.plugin.saveSettings();
        })
      );
    new Setting(containerEl).setName("Dotted background").addToggle((t) =>
      t.setValue(s.dots).onChange((v) => {
        s.dots = v;
        this.plugin.saveSettings();
        this.plugin.eachView((view) => view.updateBackground());
      })
    );
    const brushes = new Setting(containerEl)
      .setName("Imported brushes")
      .setDesc(`${this.plugin.lib.user.length} imported. Supports Procreate .brush / .brushset and Krita .kpp / .bundle / .gbr / .gih.`);
    const input = containerEl.createEl("input", { type: "file" });
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []);
      input.value = "";
      if (files.length) await this.plugin.importBrushes(files);
      this.display();
    });
    brushes.addButton((b) => b.setButtonText("Import…").setCta().onClick(() => input.click()));
    for (const b of this.plugin.lib.user) {
      new Setting(containerEl).setName(b.name).setDesc(b.source + (b.tip ? " · textured" : " · pure vector")).addExtraButton((x) =>
        x.setIcon("trash-2").setTooltip("Remove").onClick(() => {
          if (s.pen.brush === b.id) s.pen.brush = "ink";
          this.plugin.lib.remove(b.id);
          this.plugin.persistBrushes();
          this.display();
        })
      );
    }
  }
}
