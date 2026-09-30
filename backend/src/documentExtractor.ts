import OpenAI from 'openai';
import { dedicatedFetch } from './mcpClient.js';

export interface ExtractedIodCondition {
  condition_no: string;
  requirement: string;
  authority: string;
  stage: string; // e.g. 'Before Plinth CC', 'Before Further CC', 'Before OC', 'General'
  category: string; // e.g. 'Fire', 'Tree', 'Civil Aviation', 'SWD', 'Structural', 'Environmental', 'Other'
  mandatory: boolean;
}

export interface ExtractedIodDocument {
  file_name: string;
  iod_reference?: string;
  sanction_date?: string;
  total_conditions: number;
  conditions: ExtractedIodCondition[];
  raw_summary?: string;
  uploaded_at: string;
}

export interface ExtractedClearanceDoc {
  permission_id: string;
  permission_name: string;
  document_type: string;
  sanctioned_height_floors?: string;
  approval_date?: string;
  valid_until?: string;
  conditions_imposed: string[];
  remarks_notes?: string; // Additional remarks/notes field
  status: string;
  file_name: string;
  direct_url?: string;
}

export interface UnifiedMasterContext {
  project_id: string;
  total_permissions: number;
  total_documents_analyzed: number;
  clearances: ExtractedClearanceDoc[];
  unprocessed_permissions: Array<{ id: string; name: string; status: string; reason?: string }>;
}

// In-memory session cache for extracted documents by URL/file hash to guarantee $0.00 re-processing cost
const documentExtractionCache = new Map<string, ExtractedClearanceDoc>();

/**
 * Extracts raw digital text from an in-memory PDF buffer using pdf-parse.
 */
export async function parsePdfBuffer(buffer: Buffer): Promise<{ text: string; pages: number }> {
  try {
    const pdfParseMod = await import('pdf-parse');
    const PDFParse = (pdfParseMod as any).PDFParse || (pdfParseMod as any).default?.PDFParse || (pdfParseMod as any).default;
    const parser = new PDFParse(new Uint8Array(buffer));
    await parser.load();
    const parsed = await parser.getText();
    const rawText = parsed.text || '';
    const totalPages = parsed.total || (parsed.pages ? parsed.pages.length : 1);
    return { text: rawText, pages: totalPages };
  } catch (err: any) {
    console.error('❌ Error parsing PDF buffer with pdf-parse:', err);
    throw new Error(`Failed to parse PDF text: ${err?.message || err}`);
  }
}

/**
 * Ingests an uploaded IOD PDF buffer and uses gpt-4o-mini to extract all municipal sanction conditions.
 */
export async function extractIodConditionsFromBuffer(
  buffer: Buffer,
  fileName: string,
  openaiClient: OpenAI
): Promise<ExtractedIodDocument> {
  console.log(`📄 Ingesting and parsing uploaded IOD PDF: ${fileName} (${buffer.length} bytes)...`);
  const { text: rawText, pages } = await parsePdfBuffer(buffer);

  if (!rawText || rawText.trim().length === 0) {
    return {
      file_name: fileName,
      total_conditions: 0,
      conditions: [],
      raw_summary: 'Uploaded PDF appears to be a scanned image without an embedded digital text layer.',
      uploaded_at: new Date().toISOString()
    };
  }

  // Cap text to avoid extreme prompt bloat while capturing conditions (up to 40k characters)
  const cappedText = rawText.length > 40000 ? rawText.slice(0, 40000) + '\n... [TRUNCATED]' : rawText;

  console.log(`🧠 Calling gpt-4o-mini to extract sanction conditions from ${fileName} (${pages} pages, ${rawText.length} chars)...`);

  const prompt = `You are a municipal real estate compliance expert specializing in Indian municipal approvals (MCGM, MHADA, SRA).
Analyze the following Intimation of Disapproval (IOD) / Sanction letter and extract all specific conditions, restrictions, and required clearances.

Return ONLY a JSON object conforming exactly to this structure:
{
  "iod_reference": "reference number of the sanction letter or null",
  "sanction_date": "YYYY-MM-DD or null",
  "summary": "Brief 1-2 sentence overview of the sanction",
  "conditions": [
    {
      "condition_no": "Condition number (e.g. '17', '23(a)', 'C-4')",
      "requirement": "Exact description of requirement or clearance needed",
      "authority": "Target authority (e.g. 'CFO', 'Tree Authority', 'SWD', 'Traffic', 'Civil Aviation', 'EE BP')",
      "stage": "When required (e.g. 'Before Plinth CC', 'Before Further CC', 'Before Full CC', 'Before OC', 'General')",
      "category": "Fire | Tree | Environment | Water/SWD | Aviation | Structural | Legal | Other",
      "mandatory": true
    }
  ]
}

DOCUMENT TEXT:
${cappedText}`;

  const completion = await openaiClient.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    messages: [
      { role: 'system', content: 'You are an elite real estate compliance parser. Always output valid JSON.' },
      { role: 'user', content: prompt }
    ],
    response_format: { type: 'json_object' }
  });

  const content = completion.choices[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(content);
    const conditions: ExtractedIodCondition[] = Array.isArray(parsed.conditions) ? parsed.conditions : [];

    console.log(`✅ Extracted ${conditions.length} conditions from IOD: ${fileName}`);

    return {
      file_name: fileName,
      iod_reference: parsed.iod_reference || undefined,
      sanction_date: parsed.sanction_date || undefined,
      total_conditions: conditions.length,
      conditions,
      raw_summary: parsed.summary || `Extracted ${conditions.length} sanction conditions across ${pages} pages.`,
      uploaded_at: new Date().toISOString()
    };
  } catch (err: any) {
    console.error('❌ Failed to parse IOD JSON response:', err);
    return {
      file_name: fileName,
      total_conditions: 0,
      conditions: [],
      raw_summary: 'Failed to parse conditions JSON.',
      uploaded_at: new Date().toISOString()
    };
  }
}

/**
 * Downloads a single clearance PDF from S3/URL, extracts text, and uses gpt-4o-mini to extract structured schema.
 */
export async function extractSingleClearancePdf(
  perm: any,
  openaiClient: OpenAI,
  token?: string
): Promise<ExtractedClearanceDoc | null> {
  const permName = String(perm.name || 'Unnamed Clearance');
  const permId = String(perm.id || '');
  const docUrl = String(perm.ai_view_url || perm.url || '');

  if (!docUrl) return null;

  // Filter out AutoCAD DWG files
  const lowerUrl = docUrl.toLowerCase();
  if (lowerUrl.endsWith('.dwg') || lowerUrl.includes('.dwg?')) {
    console.log(`⏩ Skipping DWG CAD file for clearance: ${permName}`);
    return null;
  }

  // Check in-memory cache
  if (documentExtractionCache.has(docUrl)) {
    console.log(`⚡ Serving cached clearance extraction for ${permName}`);
    return documentExtractionCache.get(docUrl)!;
  }

  try {
    console.log(`📥 Downloading clearance PDF for ${permName} from S3...`);
    const isS3Url = lowerUrl.includes('amazonaws.com') || lowerUrl.includes('x-amz-');
    const headers: Record<string, string> = {};
    if (!isS3Url && token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['X-JWT-Token'] = token;
    }

    const resp = await dedicatedFetch(docUrl, { headers });
    if (!resp.ok) {
      console.warn(`⚠️ Failed to fetch clearance PDF ${permName}: HTTP ${resp.status}`);
      return null;
    }

    const ab = await resp.arrayBuffer();
    const buffer = Buffer.from(ab);
    const { text: rawText } = await parsePdfBuffer(buffer);

    if (!rawText || rawText.trim().length === 0) {
      const docRecord: ExtractedClearanceDoc = {
        permission_id: permId,
        permission_name: permName,
        document_type: 'Scanned Image PDF',
        status: perm.status || 'Uploaded',
        conditions_imposed: [],
        remarks_notes: 'Physical stamped scan without text layer. Visual inspection required.',
        file_name: perm.file_name || 'document.pdf',
        direct_url: docUrl
      };
      documentExtractionCache.set(docUrl, docRecord);
      return docRecord;
    }

    const cappedText = rawText.length > 12000 ? rawText.slice(0, 12000) + '\n... [TRUNCATED]' : rawText;

    const prompt = `Analyze this municipal clearance document for clearance "${permName}" and extract its key approval details and conditions into a clean JSON structure.

Return ONLY a JSON object conforming exactly to this structure:
{
  "permission_name": "${permName}",
  "document_type": "Provisional NOC | Final NOC | Remarks Letter | Sanction Letter | Demand Note | Receipt | Other",
  "sanctioned_height_floors": "Approved height or floor count (e.g. 'Stilt + 22 Floors (69.8m)') or null",
  "approval_date": "YYYY-MM-DD or null",
  "valid_until": "YYYY-MM-DD or null",
  "conditions_imposed": [
    "Key condition or obligation imposed by this authority"
  ],
  "remarks_notes": "Important additional remarks, bank guarantees, cess payments, phase limitations, or caveats",
  "status": "Approved | Conditional | Expired | Under Scrutiny"
}

DOCUMENT CONTENT:
${cappedText}`;

    const completion = await openaiClient.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'You are an Indian municipal compliance document extractor. Output valid JSON only.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');

    const resultDoc: ExtractedClearanceDoc = {
      permission_id: permId,
      permission_name: permName,
      document_type: parsed.document_type || 'NOC / Sanction Letter',
      sanctioned_height_floors: parsed.sanctioned_height_floors || undefined,
      approval_date: parsed.approval_date || undefined,
      valid_until: parsed.valid_until || undefined,
      conditions_imposed: Array.isArray(parsed.conditions_imposed) ? parsed.conditions_imposed : [],
      remarks_notes: parsed.remarks_notes || perm.remark || undefined,
      status: parsed.status || perm.status || 'Approved',
      file_name: perm.file_name || 'clearance.pdf',
      direct_url: docUrl
    };

    // Cache the result
    documentExtractionCache.set(docUrl, resultDoc);
    console.log(`✅ Extracted schema for ${permName} (Valid: ${resultDoc.valid_until || 'N/A'}, Notes: ${resultDoc.remarks_notes || 'None'})`);
    return resultDoc;
  } catch (err: any) {
    console.error(`❌ Error extracting clearance PDF for ${permName}:`, err);
    return null;
  }
}

/**
 * Runs the Multi-PDF Processing Loop in parallel batches of size 4-5 using gpt-4o-mini.
 * Aggregates all results into a Unified Master Context (~1,500 tokens).
 */
export async function processClearancePdfsInBatches(
  permissions: any[],
  projectId: string,
  openaiClient: OpenAI,
  token?: string,
  onProgress?: (msg: string) => void,
  batchSize = 4
): Promise<UnifiedMasterContext> {
  console.log(`🚀 Starting parallel batch extraction for project ${projectId} (${permissions.length} total permissions)...`);

  const inspectablePerms: any[] = [];
  const unprocessedPerms: Array<{ id: string; name: string; status: string; reason?: string }> = [];

  for (const p of permissions) {
    const permName = p.name || 'Unnamed';
    const docUrl = p.ai_view_url || p.url || '';
    const lowerUrl = docUrl.toLowerCase();

    if (!docUrl) {
      unprocessedPerms.push({
        id: String(p.id),
        name: permName,
        status: p.status || 'Pending',
        reason: 'No document attached in Stallion'
      });
      continue;
    }

    if (lowerUrl.endsWith('.dwg') || lowerUrl.includes('.dwg?')) {
      unprocessedPerms.push({
        id: String(p.id),
        name: permName,
        status: p.status || 'Approved',
        reason: 'AutoCAD DWG file (binary vector CAD)'
      });
      continue;
    }

    // PDF attachment ready for inspection
    inspectablePerms.push(p);
  }

  if (onProgress && inspectablePerms.length > 0) {
    onProgress(`Detected ${inspectablePerms.length} clearance PDFs in Stallion master data. Processing in parallel batches...`);
  }

  const extractedClearances: ExtractedClearanceDoc[] = [];

  // Execute in parallel batches of size `batchSize`
  for (let i = 0; i < inspectablePerms.length; i += batchSize) {
    const chunk = inspectablePerms.slice(i, i + batchSize);
    console.log(`📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(inspectablePerms.length / batchSize)} (${chunk.length} PDFs)...`);

    const chunkPromises = chunk.map((perm) => extractSingleClearancePdf(perm, openaiClient, token));
    const chunkResults = await Promise.all(chunkPromises);

    for (const res of chunkResults) {
      if (res) {
        extractedClearances.push(res);
      }
    }
  }

  console.log(`🏁 Batch loop completed. Successfully summarized ${extractedClearances.length} clearance documents.`);

  return {
    project_id: projectId,
    total_permissions: permissions.length,
    total_documents_analyzed: extractedClearances.length,
    clearances: extractedClearances,
    unprocessed_permissions: unprocessedPerms
  };
}
