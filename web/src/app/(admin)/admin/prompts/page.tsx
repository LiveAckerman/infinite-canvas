"use client";

import { CheckCircleOutlined, CloseCircleOutlined, CopyOutlined, DeleteOutlined, EditOutlined, ExportOutlined, EyeOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, SyncOutlined } from "@ant-design/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { App, Badge, Button, Card, Col, Flex, Form, Image, Input, Modal, Row, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import { useEffect, useState } from "react";
import copy from "copy-to-clipboard";

import type { Prompt } from "@/services/api/prompts";
import { useAdminPrompts } from "../hooks/use-admin-prompts";

export default function AdminPromptsPage() {
  const { categories, prompts, tags, keyword, category, tag, visibility, page, pageSize, total, pendingCount, isLoading, isSyncing, searchPrompts, changeCategory, changeTag, changeVisibility, changePage, changePageSize, resetFilters, refreshPrompts, syncCategory, savePrompt: saveAdminPrompt, deletePrompt, reviewPrompt } = useAdminPrompts();
  const { message } = App.useApp();
  const [form] = Form.useForm<Partial<Prompt> & { tagText?: string }>();
  const [editingPrompt, setEditingPrompt] = useState<Partial<Prompt> | null>(null);
  const [detailPrompt, setDetailPrompt] = useState<Prompt | null>(null);
  const [deletingPrompt, setDeletingPrompt] = useState<Prompt | null>(null);
  const [isSyncOpen, setIsSyncOpen] = useState(false);
  const defaultCategory = categories[0]?.category || "";
  const categoryName = (category: string) => categories.find((item) => item.category === category)?.name || category;
  const categoryOptions = [{ label: "全部分类", value: "" }, ...categories.map((item) => ({ label: item.name, value: item.category }))];
  const tagOptions = tags.map((item) => ({ label: item, value: item }));

  useEffect(() => {
    if (editingPrompt) form.setFieldsValue({ ...editingPrompt, tagText: editingPrompt.tags?.join(", ") || "" });
  }, [editingPrompt, form]);

  const copyPrompt = async (value: string) => {
    copy(value);
    message.success("已复制");
  };

  const savePrompt = async () => {
    const value = await form.validateFields();
    await saveAdminPrompt({ ...editingPrompt, ...value, category: value.category || defaultCategory, tags: (value.tagText || "").split(",").map((item) => item.trim()).filter(Boolean) });
    setEditingPrompt(null);
  };

  const columns: ProColumns<Prompt>[] = [
    {
      title: "封面",
      dataIndex: "coverUrl",
      width: 88,
      render: (_, item) => <Image src={item.coverUrl || "/logo.svg"} alt={item.title} width={56} height={42} style={{ objectFit: "cover", borderRadius: 6 }} preview={{ mask: "放大" }} fallback="/logo.svg" />,
    },
    {
      title: "标题",
      dataIndex: "title",
      width: 260,
      render: (_, item) => <Typography.Link strong ellipsis style={{ maxWidth: 260, display: "block" }} onClick={() => setDetailPrompt(item)}>{item.title}</Typography.Link>,
    },
    {
      title: "分类",
      dataIndex: "category",
      width: 150,
      render: (_, item) => <Typography.Text type="secondary">{categoryName(item.category)}</Typography.Text>,
    },
    {
      title: "标签",
      dataIndex: "tags",
      width: 180,
      render: (_, item) => <Space size={[4, 4]} wrap>{(item.tags || []).slice(0, 3).map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space>,
    },
    {
      title: "状态",
      dataIndex: "visibility",
      width: 110,
      render: (_, item) => {
        const v = item.visibility || "public";
        if (v === "pending") return <Tag color="gold">待审核</Tag>;
        if (v === "rejected") return <Tag color="red">已拒绝</Tag>;
        return <Tag color="green">已公开</Tag>;
      },
    },
    {
      title: "操作",
      key: "actions",
      width: 200,
      align: "right",
      render: (_, item) => {
        const isPending = item.visibility === "pending";
        return (
          <Space size={4}>
            {isPending ? (
              <>
                <Tooltip title="通过"><Button type="text" size="small" icon={<CheckCircleOutlined style={{ color: "#16a34a" }} />} onClick={() => void reviewPrompt(item.id, true)} /></Tooltip>
                <Tooltip title="拒绝"><Button type="text" size="small" icon={<CloseCircleOutlined style={{ color: "#dc2626" }} />} onClick={() => void reviewPrompt(item.id, false)} /></Tooltip>
              </>
            ) : null}
            <Tooltip title="详情"><Button type="text" size="small" icon={<EyeOutlined />} onClick={() => setDetailPrompt(item)} /></Tooltip>
            <Tooltip title="编辑"><Button type="text" size="small" icon={<EditOutlined />} onClick={() => setEditingPrompt(item)} /></Tooltip>
            <Tooltip title="删除"><Button danger type="text" size="small" icon={<DeleteOutlined />} onClick={() => setDeletingPrompt(item)} /></Tooltip>
          </Space>
        );
      },
    },
  ];

  return (
    <main style={{ padding: 24 }}>
      <Flex vertical gap={16}>
        <Segmented
          value={visibility || "all"}
          onChange={(value) => changeVisibility(value === "all" ? "" : (value as string))}
          options={[
            { label: "全部", value: "all" },
            {
              label: (
                <span>
                  待审核 <Badge count={pendingCount} size="small" style={{ backgroundColor: pendingCount ? "#dc2626" : undefined }} />
                </span>
              ),
              value: "pending",
            },
            { label: "已公开", value: "public" },
            { label: "已拒绝", value: "rejected" },
          ]}
        />
        <Card variant="borderless">
          <Form layout="vertical">
            <Row gutter={16} align="bottom">
              <Col flex="360px"><Form.Item label="关键词"><Input.Search value={keyword} placeholder="搜索标题或提示词" allowClear enterButton={<SearchOutlined />} onSearch={searchPrompts} onChange={(event) => searchPrompts(event.target.value)} /></Form.Item></Col>
              <Col flex="220px"><Form.Item label="分组"><Select value={category} onChange={changeCategory} options={categoryOptions} /></Form.Item></Col>
              <Col flex="220px"><Form.Item label="标签"><Select mode="multiple" allowClear maxTagCount="responsive" value={tag} onChange={changeTag} options={tagOptions} placeholder="全部标签" /></Form.Item></Col>
              <Col flex="none"><Form.Item><Space><Button onClick={resetFilters}>重置</Button><Button type="primary" icon={<ReloadOutlined />} onClick={refreshPrompts}>查询</Button></Space></Form.Item></Col>
            </Row>
          </Form>
        </Card>
        <ProTable<Prompt>
          rowKey="id"
          columns={columns}
          dataSource={prompts}
          loading={isLoading}
          search={false}
          defaultSize="middle"
          tableLayout="fixed"
          cardProps={{ variant: "borderless" }}
          headerTitle={<Space><Typography.Text strong>提示词列表</Typography.Text><Tag>{total} 条</Tag></Space>}
          options={{ density: true, setting: true, reload: () => void refreshPrompts() }}
          toolBarRender={() => [<Button key="sync" icon={<SyncOutlined />} onClick={() => setIsSyncOpen(true)}>同步</Button>, <Button key="add" type="primary" icon={<PlusOutlined />} onClick={() => setEditingPrompt({ category: defaultCategory, tags: [] })}>新增</Button>]}
          pagination={{ current: page, pageSize, total, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100], showTotal: (value) => `共 ${value} 条`, onChange: (nextPage, nextPageSize) => nextPageSize !== pageSize ? changePageSize(nextPageSize) : changePage(nextPage) }}
        />
      </Flex>

      <Modal title={editingPrompt?.id ? "编辑提示词" : "新增提示词"} open={Boolean(editingPrompt)} width={720} onCancel={() => setEditingPrompt(null)} onOk={() => void savePrompt()} okText="保存" cancelText="取消" destroyOnHidden>
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}><Input /></Form.Item>
          <Form.Item name="category" label="分类"><Select options={categories.map((item) => ({ label: item.name, value: item.category }))} /></Form.Item>
          <Form.Item name="coverUrl" label="封面 URL"><Input /></Form.Item>
          <Form.Item name="tagText" label="标签，用逗号分隔"><Input /></Form.Item>
          <Form.Item name="prompt" label="提示词" rules={[{ required: true, message: "请输入提示词" }]}><Input.TextArea rows={6} /></Form.Item>
        </Form>
      </Modal>

      <Modal title="提示词详情" open={Boolean(detailPrompt)} width={760} onCancel={() => setDetailPrompt(null)} footer={<Button onClick={() => setDetailPrompt(null)}>关闭</Button>}>
        {detailPrompt ? (
          <Flex vertical gap={14}>
            <Flex gap={14} align="start">
              <Image src={detailPrompt.coverUrl || "/logo.svg"} alt={detailPrompt.title} width={116} height={84} style={{ objectFit: "cover", borderRadius: 8 }} preview={{ mask: "放大" }} fallback="/logo.svg" />
              <Flex vertical gap={8} style={{ minWidth: 0 }}>
                <Typography.Title level={5} style={{ margin: 0 }}>{detailPrompt.title}</Typography.Title>
                <Space wrap><Tag>{categoryName(detailPrompt.category)}</Tag>{(detailPrompt.tags || []).map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space>
              </Flex>
            </Flex>
            {detailPrompt.preview ? <Typography.Paragraph type="secondary" style={{ margin: 0 }}>{detailPrompt.preview}</Typography.Paragraph> : null}
            <Input.TextArea value={detailPrompt.prompt} rows={8} readOnly />
            <Space>
              <Button icon={<CopyOutlined />} onClick={() => void copyPrompt(detailPrompt.prompt)}>复制提示词</Button>
              {detailPrompt.githubUrl ? <Button icon={<ExportOutlined />} href={detailPrompt.githubUrl} target="_blank">远程源</Button> : null}
            </Space>
          </Flex>
        ) : null}
      </Modal>

      <Modal title="同步远程提示词源" open={isSyncOpen} width={640} onCancel={() => !isSyncing && setIsSyncOpen(false)} maskClosable={!isSyncing} footer={<Button disabled={isSyncing} onClick={() => setIsSyncOpen(false)}>取消</Button>}>
        <Table
          rowKey="category"
          dataSource={categories.filter((item) => item.remote)}
          pagination={false}
          columns={[
            { title: "远程源", dataIndex: "name", render: (_, item) => <Flex align="center" gap={8}>{item.name}{item.githubUrl ? <Typography.Link href={item.githubUrl} target="_blank"><ExportOutlined /></Typography.Link> : null}</Flex> },
            { title: "", key: "sync", width: 96, align: "right", render: (_, item) => <Button type="primary" loading={isSyncing} onClick={async () => { try { await syncCategory(item.category); setIsSyncOpen(false); } catch {} }}>同步</Button> },
          ]}
        />
      </Modal>

      <Modal title="删除提示词" open={Boolean(deletingPrompt)} onCancel={() => setDeletingPrompt(null)} onOk={async () => { if (!deletingPrompt) return; await deletePrompt(deletingPrompt.id); setDeletingPrompt(null); }} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
        确定删除「{deletingPrompt?.title}」吗？删除后会从当前分类中删除。
      </Modal>
    </main>
  );
}
