import { useCallback, useEffect, useMemo, useRef, useState, forwardRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  BeautifulMentionsPlugin,
  BeautifulMentionNode,
  ZeroWidthPlugin,
  ZeroWidthNode,
} from "lexical-beautiful-mentions";
import type {
  BeautifulMentionsComboboxProps,
  BeautifulMentionsComboboxItemProps,
  BeautifulMentionsItem,
} from "lexical-beautiful-mentions";
import {
  $getRoot,
  KEY_ENTER_COMMAND,
  COMMAND_PRIORITY_LOW,
  CLEAR_EDITOR_COMMAND,
} from "lexical";
import { ClearEditorPlugin } from "@lexical/react/LexicalClearEditorPlugin";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SlashCommand {
  name: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Combobox components
// ---------------------------------------------------------------------------

const Combobox = forwardRef<HTMLDivElement, BeautifulMentionsComboboxProps>(
  function Combobox({ loading, itemType, children, ...props }, ref) {
    if (itemType === "trigger") {
      return <div ref={ref} className="hidden" {...props} />;
    }
    if (loading) {
      return (
        <div
          ref={ref}
          className="w-full rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow-md"
        >
          <span className="animate-pulse text-muted-foreground">Loading commands…</span>
        </div>
      );
    }
    const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
    if (!hasChildren) {
      return (
        <div
          ref={ref}
          className="w-full rounded-md border bg-popover p-3 text-sm text-muted-foreground shadow-md"
        >
          No commands available
        </div>
      );
    }
    return (
      <ul
        ref={ref}
        {...props}
        style={{ scrollbarWidth: "none" }}
        className="w-full max-h-[300px] list-none overflow-y-scroll overscroll-contain rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      />
    );
  },
);

const ComboboxItem = forwardRef<HTMLLIElement, BeautifulMentionsComboboxItemProps>(
  function ComboboxItem({ selected, item, ...props }, ref) {
    if (item.itemType === "trigger") {
      return (
        <li ref={ref} {...props} className={cn("cursor-pointer rounded-sm px-2 py-1.5 text-sm", selected && "bg-accent text-accent-foreground")}>
          {item.value}
        </li>
      );
    }
    return (
      <li
        ref={ref}
        {...props}
        className={cn(
          "flex flex-col gap-0.5 cursor-pointer rounded-sm px-2 py-1.5 text-sm outline-none",
          selected && "bg-accent text-accent-foreground",
        )}
      >
        <span className="font-medium">/{item.value}</span>
        {item.data?.description ? (
          <span className="text-xs text-muted-foreground line-clamp-1">
            {String(item.data.description)}
          </span>
        ) : null}
      </li>
    );
  },
);

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

function EnterToSendPlugin({
  onSend,
  comboboxOpen,
}: {
  onSend: (text: string) => void;
  comboboxOpen: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const openRef = useRef(comboboxOpen);
  openRef.current = comboboxOpen;

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event?.shiftKey) return false;
        if (openRef.current) return false;
        event?.preventDefault();
        const text = editor.getEditorState().read(() => $getRoot().getTextContent());
        if (!text.trim()) return true;
        onSend(text);
        editor.dispatchCommand(CLEAR_EDITOR_COMMAND, undefined);
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, onSend]);

  return null;
}

function EditablePlugin({ editable }: { editable: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { editor.setEditable(editable); }, [editor, editable]);
  return null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SlashCommandInput({
  commands,
  onSend,
  disabled = false,
  placeholder = "Send a prompt to the agent…",
  className,
}: {
  commands: SlashCommand[];
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [comboboxOpen, setComboboxOpen] = useState(false);

  const onSearch = useCallback(
    async (_trigger: string, query?: string | null): Promise<BeautifulMentionsItem[]> => {
      const q = (query ?? "").toLowerCase();
      return commands
        .filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
        .map((c) => ({ value: c.name, description: c.description }));
    },
    [commands],
  );

  const initialConfig = useMemo(
    () => ({
      namespace: "SlashCommandInput",
      onError: (error: Error) => console.error("Lexical error:", error),
      nodes: [BeautifulMentionNode, ZeroWidthNode],
      theme: {
        beautifulMentions: {
          "/": "slash-mention",
        },
      },
    }),
    [],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className={cn("relative flex-1", className)}>
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className={cn(
                "h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors",
                "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                disabled && "cursor-not-allowed opacity-50",
              )}
              aria-placeholder={placeholder}
              placeholder={
                <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground select-none">
                  {placeholder}
                </div>
              }
            />
          }
          ErrorBoundary={LexicalErrorBoundary as any}
        />
        <BeautifulMentionsPlugin
          triggers={["/"]}
          onSearch={onSearch}
          searchDelay={0}
          menuItemLimit={false}
          combobox
          comboboxAnchorClassName="slash-combobox-anchor"
          comboboxComponent={Combobox}
          comboboxItemComponent={ComboboxItem}
          onComboboxOpen={() => setComboboxOpen(true)}
          onComboboxClose={() => setComboboxOpen(false)}
          allowSpaces={true}
          autoSpace={true}
        />
        <ClearEditorPlugin />
        <ZeroWidthPlugin />
        <EnterToSendPlugin onSend={onSend} comboboxOpen={comboboxOpen} />
        <EditablePlugin editable={!disabled} />
      </div>
    </LexicalComposer>
  );
}
