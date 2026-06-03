"use client";

import { DeleteOutlined, ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { App, Button, Card, Col, Flex, Progress, Row, Space, Statistic, Tag, Tooltip, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  cleanupAdminStorageOrphans,
  fetchAdminStorageOrphans,
  type ImageUsageByUser,
  type OrphanImageItem,
} from "@/services/api/admin-storage";
import { useUserStore } from "@/stores/use-user-store";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export default function AdminStoragePage() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const token = useUserStore((state) => state.token);

  const query = useQuery({
    queryKey: ["admin", "storage", "orphans", token],
    queryFn: () => fetchAdminStorageOrphans(token),
    enabled: Boolean(token),
    retry: false,
  });

  const cleanupMutation = useMutation({
    mutationFn: () => cleanupAdminStorageOrphans(token),
    onSuccess: async (result) => {
      message.success(`已清理 ${result.cleanedCount} 张孤儿图片，释放 ${formatBytes(result.freedBytes)}`);
      await queryClient.invalidateQueries({ queryKey: ["admin", "storage", "orphans"] });
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "清理失败");
    },
  });

  const confirmCleanup = () => {
    if (!query.data || query.data.totalCount === 0) {
      message.info("当前没有孤儿图片");
      return;
    }
    modal.confirm({
      title: "确认清理孤儿图片",
      content: (
        <Space direction="vertical" size={4}>
          <span>共 {query.data.totalCount} 张孤儿图片，预计释放 {formatBytes(query.data.totalBytes)}。</span>
          <span>这些图片已不在任何画布 / 生成记录 / 素材 / 角色 / 工作区卡片 / 流水线中。</span>
          <Typography.Text type="danger">该操作不可撤销。</Typography.Text>
        </Space>
      ),
      okText: "确认清理",
      okButtonProps: { danger: true },
      cancelText: "取消",
      // mutateAsync 已经返回 Promise → antd Modal OK 按钮自动跟着转 loading；
      // .catch 让失败时 modal 也能关掉（错误已由 mutation onError 弹 toast）
      onOk: () => cleanupMutation.mutateAsync().catch(() => undefined),
    });
  };

  const stats = query.data;
  const orphanShare = stats ? Math.round(stats.orphanShare * 1000) / 10 : 0;

  const orphanColumns: ProColumns<OrphanImageItem>[] = [
    { title: "图片 ID", dataIndex: "id", width: 240, render: (_, item) => <Typography.Text copyable={{ text: item.id }} ellipsis>{item.id}</Typography.Text> },
    { title: "Owner", dataIndex: "username", width: 140, render: (_, item) => item.username || <Typography.Text type="secondary">（用户已删）</Typography.Text> },
    { title: "类型", dataIndex: "mimeType", width: 100 },
    { title: "大小", dataIndex: "size", width: 100, render: (_, item) => formatBytes(item.size) },
    { title: "创建时间", dataIndex: "createdAt", width: 180 },
  ];

  const usageColumns: ProColumns<ImageUsageByUser>[] = [
    { title: "用户", dataIndex: "username", width: 200, render: (_, item) => item.username || <Typography.Text type="secondary">{item.userId.slice(0, 16)}…</Typography.Text> },
    { title: "图片数", dataIndex: "imageCount", width: 100, sorter: (a, b) => a.imageCount - b.imageCount },
    { title: "占用", dataIndex: "totalBytes", width: 140, render: (_, item) => formatBytes(item.totalBytes), sorter: (a, b) => a.totalBytes - b.totalBytes, defaultSortOrder: "descend" },
  ];

  return (
    <main style={{ padding: 24 }}>
      <Flex vertical gap={16}>
        <Card variant="borderless">
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            「孤儿图片」 = 不在任何画布 / 生成记录 / 素材 / 角色 / 工作区卡片 / 流水线中引用的图片。用户主动删除业务对象时已经自动级联清理；这里是兜底入口，可以一键扫一遍历史遗留。
          </Typography.Paragraph>
        </Card>

        <Row gutter={16}>
          <Col xs={24} sm={12} md={6}>
            <Card>
              <Statistic title="全库图片总数" value={stats?.grandImages ?? 0} suffix="张" loading={query.isLoading} />
            </Card>
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Card>
              <Statistic title="全库总占用" value={stats ? formatBytes(stats.grandBytes) : "—"} loading={query.isLoading} />
            </Card>
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Card>
              <Statistic
                title={<Space size={4}><WarningOutlined style={{ color: stats && stats.totalCount > 0 ? "#faad14" : undefined }} />孤儿图片数</Space>}
                value={stats?.totalCount ?? 0}
                suffix="张"
                valueStyle={{ color: stats && stats.totalCount > 0 ? "#faad14" : undefined }}
                loading={query.isLoading}
              />
            </Card>
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Card>
              <Statistic title="孤儿占用" value={stats ? formatBytes(stats.totalBytes) : "—"} loading={query.isLoading} />
              {stats ? <Progress percent={orphanShare} size="small" status={orphanShare > 30 ? "exception" : "normal"} format={(v) => `${v}%`} style={{ marginTop: 8 }} /> : null}
            </Card>
          </Col>
        </Row>

        <Card
          title={<Space><Typography.Text strong>孤儿图片明细</Typography.Text><Tag>{stats?.totalCount ?? 0}</Tag></Space>}
          extra={(
            <Space>
              <Button icon={<ReloadOutlined />} onClick={() => void query.refetch()} loading={query.isFetching}>刷新</Button>
              <Tooltip title={!stats?.totalCount ? "没有可清理的孤儿" : undefined}>
                <Button
                  danger
                  type="primary"
                  icon={<DeleteOutlined />}
                  disabled={!stats?.totalCount}
                  loading={cleanupMutation.isPending}
                  onClick={confirmCleanup}
                >
                  清理全部孤儿（{stats ? formatBytes(stats.totalBytes) : "0"}）
                </Button>
              </Tooltip>
            </Space>
          )}
          variant="borderless"
        >
          <ProTable<OrphanImageItem>
            rowKey="id"
            columns={orphanColumns}
            dataSource={stats?.items || []}
            loading={query.isLoading}
            search={false}
            options={false}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            tableLayout="fixed"
          />
        </Card>

        <Card title={<Typography.Text strong>按用户占用排名</Typography.Text>} variant="borderless">
          <ProTable<ImageUsageByUser>
            rowKey="userId"
            columns={usageColumns}
            dataSource={stats?.usageByUser || []}
            loading={query.isLoading}
            search={false}
            options={false}
            pagination={{ pageSize: 10 }}
            tableLayout="fixed"
          />
        </Card>
      </Flex>
    </main>
  );
}
