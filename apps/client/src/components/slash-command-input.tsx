import { useCallback, useEffect, useMemo, useRef, forwardRef } from "react";
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
  COMMAND_PRIORITY_NORMAL,
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

// oxlint-disable-next-line no-explicit-any -- ref can be HTMLUListElement or HTMLDivElement
const Combobox = forwardRef<any, BeautifulMentionsComboboxProps>(function Combobox(
  { loading, itemType, ...props },
  ref,
) {
  // Trigger mode: the plugin shows available triggers (e.g. "/") before
  // one is typed. Render an invisible container so the plugin's refs stay
  // intact but nothing is visible to the user.
  if (itemType === "trigger" && !loading) {
    // oxlint-disable-next-line no-unused-vars -- destructure children out to discard them
    const { children: _triggerChildren, ...triggerRest } = props;
    return <ul ref={ref} {...triggerRest} style={{ display: "none" }} />;
  }
  // Async search in-flight — show loading indicator
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
  // Extract children to check for empty state
  const { children, ...rest } = props;
  const hasItems = Array.isArray(children) ? children.length > 0 : Boolean(children);
  if (!hasItems) {
    return (
      <div
        ref={ref}
        className="w-full rounded-md border bg-popover p-3 text-sm text-muted-foreground shadow-md"
        {...rest}
      >
        No commands available
      </div>
    );
  }
  return (
    <ul
      ref={ref}
      style={{ scrollbarWidth: "none" }}
      className="w-full max-h-[300px] list-none overflow-y-scroll overscroll-contain rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      {...rest}
    >
      {children}
    </ul>
  );
});

const ComboboxItem = forwardRef<HTMLLIElement, BeautifulMentionsComboboxItemProps>(
  function ComboboxItem({ selected, item, ...props }, ref) {
    if (item.itemType === "trigger") {
      return (
        <li
          ref={ref}
          {...props}
          className={cn(
            "cursor-pointer rounded-sm px-2 py-1.5 text-sm",
            selected && "bg-accent text-accent-foreground",
          )}
        >
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
  comboboxOpenRef,
}: {
  onSend: (text: string) => void;
  comboboxOpenRef: React.RefObject<boolean>;
}) {
  const [editor] = useLexicalComposerContext();
  const lastEnterRef = useRef(0);

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        // Let the combobox handle Enter for item selection
        if (comboboxOpenRef.current) return false;

        const now = Date.now();
        const timeSinceLastEnter = now - lastEnterRef.current;
        lastEnterRef.current = now;

        // Double-Enter (two presses within 500ms) → send message
        if (timeSinceLastEnter < 500) {
          event?.preventDefault();
          // Read text, trim trailing newlines from the first Enter
          const text = editor
            .getEditorState()
            .read(() => $getRoot().getTextContent())
            .replace(/\n+$/, "");
          if (!text.trim()) return true;
          onSend(text);
          editor.dispatchCommand(CLEAR_EDITOR_COMMAND, undefined);
          lastEnterRef.current = 0;
          return true;
        }

        // Single Enter → insert newline (let Lexical handle it)
        return false;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor, onSend, comboboxOpenRef]);

  return null;
}

function EditablePlugin({ editable }: { editable: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);
  return null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SlashCommandInput({
  fetchCommands,
  onSend,
  disabled = false,
  placeholder = "Send a prompt to the agent…",
  className,
}: {
  fetchCommands: () => Promise<SlashCommand[]>;
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  // Track combobox open state via a ref so the Enter handler can
  // check it synchronously without stale closure issues.
  const comboboxOpenRef = useRef(false);

  // Fetch commands from the API on every search invocation.
  // The plugin calls onSearch each time the user types after "/",
  // and shows the loading state while the promise is pending.
  const onSearch = useCallback(
    async (_trigger: string, query?: string | null): Promise<BeautifulMentionsItem[]> => {
      const commands = await fetchCommands();
      const q = (query ?? "").toLowerCase();
      return commands
        .filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
        .map((c) => ({ value: c.name, description: c.description }));
    },
    [fetchCommands],
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
                "min-h-8 max-h-40 w-full overflow-y-auto rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors",
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
          ErrorBoundary={LexicalErrorBoundary}
        />
        <BeautifulMentionsPlugin
          triggers={["/"]}
          onSearch={onSearch}
          searchDelay={250}
          menuItemLimit={false}
          combobox
          comboboxAnchorClassName="slash-combobox-anchor"
          comboboxComponent={Combobox}
          comboboxItemComponent={ComboboxItem}
          onComboboxOpen={() => {
            comboboxOpenRef.current = true;
          }}
          onComboboxClose={() => {
            comboboxOpenRef.current = false;
          }}
          allowSpaces={true}
          autoSpace={true}
        />
        <ClearEditorPlugin />
        <ZeroWidthPlugin />
        <EnterToSendPlugin onSend={onSend} comboboxOpenRef={comboboxOpenRef} />
        <EditablePlugin editable={!disabled} />
      </div>
    </LexicalComposer>
  );
}
