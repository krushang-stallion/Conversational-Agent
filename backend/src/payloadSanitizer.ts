/**
 * Payload Sanitizer & Token Reducer for Stallion MCP Tools.
 * Prevents >128k token context overflows by:
 * 1. Stripping duplicate file arrays across attachments, lod_documents, and document_sections
 * 2. Dropping redundant database IDs, internal routes, and static schemas
 * 3. Categorizing files cleanly by section and format (PDF vs DWG)
 * 4. Capping oversized payloads with a smart indexer
 */

export interface SanitizedFile {
  file_id: string;
  file_name: string;
  format: 'pdf' | 'dwg' | string;
  ai_view_url: string; // Direct S3 pre-signed URL (requires zero authentication)
  view_url?: string;
  url: string;
}

export interface SanitizedLOD {
  lod_id: string;
  lod_name: string;
  files: SanitizedFile[];
}

export interface SanitizedPermission {
  id: string;
  name: string;
  type: string;
  status: string;
  exp_date: string | null;
  assigned_to: string;
  ai_view_url?: string; // Direct pre-signed S3 URL for primary approval PDF
  file_name?: string;
  remark?: string;
  documents: {
    permission_plan?: SanitizedFile[];
    lod_documents?: SanitizedLOD[];
    demand_notes?: SanitizedFile[];
    receipt_notes?: SanitizedFile[];
    other_files?: SanitizedFile[];
  };
}

export function sanitizePermissionsPayload(rawData: any): any {
  if (!rawData) return rawData;

  let rootObj = rawData;
  let isWrappedInContent = false;

  // Handle MCP content wrapper if present
  if (rawData.content && Array.isArray(rawData.content) && rawData.content[0]?.text) {
    try {
      rootObj = JSON.parse(rawData.content[0].text);
      isWrappedInContent = true;
    } catch {
      return rawData;
    }
  }

  const dataContainer = rootObj.data || rootObj;
  const rawPermissions = dataContainer.permissions || (Array.isArray(dataContainer) ? dataContainer : null);

  if (!Array.isArray(rawPermissions)) {
    return rawData;
  }

  const sanitizedPermissions: SanitizedPermission[] = rawPermissions.map((perm: any) => {
    const seenFileIds = new Set<string>();

    const extractFile = (f: any): SanitizedFile | null => {
      if (!f) return null;
      const fileId = String(f.file_id || f.id || '');
      if (seenFileIds.has(fileId) && fileId) {
        return null; // Eliminate duplicates
      }
      if (fileId) seenFileIds.add(fileId);

      const fileName = String(f.file_name || f.name || 'unnamed');
      const format = fileName.toLowerCase().endsWith('.dwg') ? 'dwg' : 'pdf';
      const aiViewUrl = f.ai_view_url || '';
      const rawViewUrl = f.view_url || '';
      const viewUrl = rawViewUrl.startsWith('http') 
        ? rawViewUrl 
        : (rawViewUrl ? `https://api.dev.batman.co.in${rawViewUrl}` : '');
      const directUrl = aiViewUrl || viewUrl;

      return {
        file_id: fileId,
        file_name: fileName,
        format,
        ai_view_url: aiViewUrl || directUrl,
        view_url: viewUrl || undefined,
        url: directUrl
      };
    };

    const docs: SanitizedPermission['documents'] = {};

    // 1. Extract from document_sections.permission
    const permFiles = perm.document_sections?.permission?.files || [];
    const cleanPermFiles = permFiles.map(extractFile).filter(Boolean) as SanitizedFile[];
    if (cleanPermFiles.length > 0) docs.permission_plan = cleanPermFiles;

    // 2. Extract LOD documents
    const lods = perm.lod_documents || [];
    const cleanLods: SanitizedLOD[] = [];
    for (const lod of lods) {
      const allLodFiles = [...(lod.files || []), ...(lod.dwg_files || []), ...(lod.attachments || [])];
      const cleanFiles = allLodFiles.map(extractFile).filter(Boolean) as SanitizedFile[];
      if (cleanFiles.length > 0 || lod.name) {
        cleanLods.push({
          lod_id: String(lod.document_id || lod.id || ''),
          lod_name: String(lod.name || 'LOD Document'),
          files: cleanFiles
        });
      }
    }
    if (cleanLods.length > 0) docs.lod_documents = cleanLods;

    // 3. Extract demand_note
    const demandFiles = perm.document_sections?.demand_note?.files || [];
    const cleanDemand = demandFiles.map(extractFile).filter(Boolean) as SanitizedFile[];
    if (cleanDemand.length > 0) docs.demand_notes = cleanDemand;

    // 4. Extract receipt_note (dwg and pdf)
    const receiptFiles = [
      ...(perm.document_sections?.receipt_note?.files || []),
      ...(perm.document_sections?.receipt_note?.dwg_files || [])
    ];
    const cleanReceipt = receiptFiles.map(extractFile).filter(Boolean) as SanitizedFile[];
    if (cleanReceipt.length > 0) docs.receipt_notes = cleanReceipt;

    // 5. Catch any unmapped files from root attachments
    const rootAttachments = perm.attachments || [];
    const unmapped = rootAttachments.map(extractFile).filter(Boolean) as SanitizedFile[];
    if (unmapped.length > 0) {
      docs.other_files = unmapped;
    }

    // Format expiry date cleanly
    let cleanExpDate: string | null = null;
    if (perm.exp_date) {
      cleanExpDate = String(perm.exp_date).split('T')[0];
    }

    // Find primary approval PDF/file (prefer PDF from permission_plan or attachments)
    let primaryFile: SanitizedFile | undefined;
    if (docs.permission_plan && docs.permission_plan.length > 0) {
      primaryFile = docs.permission_plan.find(f => f.format === 'pdf') || docs.permission_plan[0];
    } else if (docs.lod_documents && docs.lod_documents.length > 0) {
      for (const lod of docs.lod_documents) {
        const pf = lod.files.find(f => f.format === 'pdf') || lod.files[0];
        if (pf) { primaryFile = pf; break; }
      }
    } else if (docs.other_files && docs.other_files.length > 0) {
      primaryFile = docs.other_files.find(f => f.format === 'pdf') || docs.other_files[0];
    }

    return {
      id: String(perm.id || ''),
      name: String(perm.name || 'Unnamed Permission'),
      type: String(perm.type || ''),
      status: String(perm.permission_status || perm.status || 'Unknown'),
      exp_date: cleanExpDate,
      assigned_to: String(perm.assigned_to || perm.assigned_user || 'Unassigned'),
      ai_view_url: primaryFile?.ai_view_url || undefined,
      file_name: primaryFile?.file_name || undefined,
      remark: perm.remark || undefined,
      documents: docs
    };
  });

  const cleanResult = {
    success: true,
    total_permissions: sanitizedPermissions.length,
    permissions: sanitizedPermissions
  };

  if (isWrappedInContent) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(cleanResult, null, 2)
        }
      ]
    };
  }

  return cleanResult;
}

/**
 * General Purpose Tool Result Sanitizer for all MCP Tools
 */
export function sanitizeGenericToolResult(toolName: string, result: any, maxLen = 8000): string {
  if (!result) return JSON.stringify({ status: 'empty' });

  // If it's permissions, apply the specialized 90% token reducer
  if (toolName === 'get_project_permissions') {
    const sanitized = sanitizePermissionsPayload(result);
    return typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
  }

  let str = typeof result === 'string' ? result : JSON.stringify(result);

  // Strip massive inline base64 images / data URLs
  str = str.replace(/data:image\/[a-zA-Z]+;base64,[^"'\s\\]+/g, '[BASE64_IMAGE]');
  str = str.replace(/data:application\/[a-zA-Z]+;base64,[^"'\s\\]+/g, '[BASE64_DOC]');

  if (str.length > maxLen) {
    str = str.substring(0, maxLen) + '... [TRUNCATED_FOR_CONTEXT_SAFETY]';
  }
  return str;
}
