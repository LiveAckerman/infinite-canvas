"use client";

import { App, Button, Modal } from "antd";
import { useState } from "react";

import { deleteCanvas } from "@/services/api/canvases";
import { useUserStore } from "@/stores/use-user-store";
import { useCanvasStore } from "../stores/use-canvas-store";
import { useCanvasUiStore } from "../stores/use-canvas-ui-store";

export function CanvasDeleteProjectsDialog() {
  const { message } = App.useApp();
  const token = useUserStore((state) => state.token);
  const ids = useCanvasUiStore((state) => state.deleteProjectIds);
  const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
  const removeSelectedIds = useCanvasUiStore((state) => state.removeSelectedProjectIds);
  // 串行删多个 canvas 时把按钮锁住 + 转 loading；防止用户连点导致并发 race。
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    setDeleting(true);
    try {
      const succeeded: string[] = [];
      for (const id of ids) {
        try {
          if (token) await deleteCanvas(token, id);
          succeeded.push(id);
        } catch (error) {
          message.error(error instanceof Error ? error.message : `删除画布 ${id} 失败`);
        }
      }
      if (succeeded.length) {
        useCanvasStore.getState().deleteProjects(succeeded);
        removeSelectedIds(succeeded);
      }
      setDeleteIds([]);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      title="删除画布？"
      open={ids.length > 0}
      centered
      // 删除过程中不允许取消 / 关闭，避免中途 state 错乱
      onCancel={() => !deleting && setDeleteIds([])}
      maskClosable={!deleting}
      closable={!deleting}
      footer={(
        <>
          <Button disabled={deleting} onClick={() => setDeleteIds([])}>取消</Button>
          <Button danger type="primary" loading={deleting} onClick={() => void confirm()}>删除</Button>
        </>
      )}
    >
      <p className="text-sm text-stone-500">将删除 {ids.length} 个画布，里面的节点、连线以及关联的图片资源也会一并删除（仍被别处引用的图片会保留）。</p>
    </Modal>
  );
}
