export type Position = {
  x: number;
  y: number;
};

export type ViewportTransform = {
  x: number;
  y: number;
  k: number;
};

export enum CanvasNodeType {
  Image = "image",
  Text = "text",
  Config = "config",
}

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image";

export type CanvasNodeMetadata = {
  content?: string;
  prompt?: string;
  status?: CanvasNodeStatus;
  errorDetails?: string;
  fontSize?: number;
  generationMode?: CanvasGenerationMode;
  model?: string;
  size?: string;
  count?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  freeResize?: boolean;
  isBatchRoot?: boolean;
  batchRootId?: string;
  batchChildIds?: string[];
  primaryImageId?: string;
  imageBatchExpanded?: boolean;
  inputOrder?: string[];
  storageKey?: string;
  mimeType?: string;
  bytes?: number;
  // 节点正在跑后端任务化生图时关联的那条 generation id（POST /api/generations/run 返回）。
  // 用于「刷新页面 / 切回画布」后按 id 续轮询，避免 loading 节点永远卡住。
  // 终态（success / error）时清空。
  runningGenerationId?: string;
};

export type CanvasNodeData = {
  id: string;
  type: CanvasNodeType;
  title: string;
  position: Position;
  width: number;
  height: number;
  metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
};

export type CanvasAssistantReference = {
  id: string;
  type: CanvasNodeType;
  title: string;
  dataUrl?: string;
  storageKey?: string;
  text?: string;
};

export type CanvasAssistantImage = {
  id: string;
  dataUrl: string;
  storageKey?: string;
  prompt: string;
};

export type CanvasAssistantMessage = {
  id: string;
  role: "user" | "assistant";
  mode: "ask" | "image";
  text: string;
  isLoading?: boolean;
  references?: CanvasAssistantReference[];
  images?: CanvasAssistantImage[];
};

export type CanvasAssistantSession = {
  id: string;
  title: string;
  messages: CanvasAssistantMessage[];
  createdAt: string;
  updatedAt: string;
};

export type ConnectionHandle = {
  nodeId: string;
  handleType: "source" | "target";
};

export type SelectionBox = {
  startWorldX: number;
  startWorldY: number;
  currentWorldX: number;
  currentWorldY: number;
  additive: boolean;
  initialSelectedNodeIds: string[];
};

export type ContextMenuState =
  {
    type: "node";
    x: number;
    y: number;
    nodeId: string;
  };
