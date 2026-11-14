import { CheckIcon, CopyIcon, InfoIcon } from "lucide-react";
import { useState } from "react";
import type { ServerProvider } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { catalogMetadataRows } from "./aixModelMetadata";

export function ModelCatalogDetails(props: {
  modelId: string;
  name: string;
  metadata: ServerProvider["models"][number]["catalogMetadata"];
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const rows = catalogMetadataRows(props.metadata);

  const copyModelId = async () => {
    try {
      await navigator.clipboard.writeText(props.modelId);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Model details for ${props.name}`}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <InfoIcon aria-hidden="true" />
          </Button>
        }
      />
      <PopoverPopup
        width="sm"
        side="top"
        align="end"
        className="max-w-[calc(100vw-1rem)]"
        data-model-picker-option-menu
      >
        <div className="space-y-2 text-xs">
          <p className="truncate font-medium">{props.name}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {rows.map((row) => (
              <div key={row.label} className="contents">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="min-w-0 break-words text-right">{row.value}</dd>
              </div>
            ))}
          </dl>
          <div className="flex min-w-0 items-center gap-1 border-t border-border/70 pt-2">
            <code className="min-w-0 flex-1 break-all text-muted-foreground">{props.modelId}</code>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={
                copyFailed
                  ? "Could not copy model ID"
                  : copied
                    ? "Model ID copied"
                    : "Copy model ID"
              }
              onClick={() => void copyModelId()}
            >
              {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            </Button>
          </div>
          <p className="sr-only" aria-live="polite">
            {copyFailed ? "Could not copy model ID" : copied ? "Model ID copied" : ""}
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
