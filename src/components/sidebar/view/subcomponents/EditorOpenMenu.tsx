import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ChevronDown, SquareCode } from "lucide-react";
import type { TFunction } from "i18next";
import { cn } from "../../../../lib/utils";
import {
  buildEditorWorkspaceUri,
  WORKSPACE_EDITORS,
} from "../../utils/editorLinks";

type EditorOpenMenuProps = {
  directory: string;
  mobile?: boolean;
  t: TFunction;
};

export default function EditorOpenMenu({
  directory,
  mobile = false,
  t,
}: EditorOpenMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  const toggleMenu = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    event.stopPropagation();
    setIsOpen((open) => !open);
  };

  return (
    <div ref={containerRef} className="relative">
      <div
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className={cn(
          "flex cursor-pointer items-center justify-center rounded transition-all duration-200",
          mobile
            ? "h-8 w-8 border border-primary/20 bg-primary/10 active:scale-90"
            : "touch:opacity-100 h-6 w-6 opacity-0 hover:bg-accent group-hover:opacity-100",
        )}
        title={t("tooltips.openInEditor")}
        onClick={toggleMenu}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleMenu(event);
          }
        }}
      >
        <SquareCode
          className={cn(
            mobile ? "h-4 w-4 text-primary" : "h-3 w-3 text-muted-foreground",
          )}
        />
      </div>

      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {t("actions.openInEditor")}
            <ChevronDown className="h-3 w-3" />
          </div>
          {WORKSPACE_EDITORS.map((editor) => (
            <a
              key={editor.id}
              role="menuitem"
              href={buildEditorWorkspaceUri(editor, directory)}
              className="block rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent"
              onClick={() => setIsOpen(false)}
            >
              {editor.name}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
