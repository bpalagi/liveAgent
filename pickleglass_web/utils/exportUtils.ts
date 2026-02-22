import { Session, Transcript, AiMessage, Summary } from './api';

export interface SessionDetails {
    session: Session;
    transcripts: Transcript[];
    ai_messages: AiMessage[];
    summary: Summary | null;
}

export const exportSessionToMarkdown = (sessionDetails: SessionDetails): string => {
    const { session, transcripts, ai_messages, summary } = sessionDetails;
    
    // Sanitize title for filename
    const sanitizeFilename = (title: string): string => {
        return title
            .replace(/[^\w\s-]/g, '') // Remove special characters
            .replace(/\s+/g, '-') // Replace spaces with hyphens
            .toLowerCase()
            .substring(0, 50); // Limit length
    };
    
    // Format date
    const formatDate = (timestamp: number): string => {
        return new Date(timestamp * 1000).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };
    
    // Build markdown content
    let markdown = `# ${session.title}\n\n`;
    markdown += `**Date:** ${formatDate(session.started_at)}\n`;
    markdown += `**Type:** ${session.session_type}\n\n`;
    
    // Add summary if available
    if (summary) {
        markdown += `## Summary\n\n`;
        markdown += `> ${summary.tldr}\n\n`;
        
        if (summary.bullet_json) {
            try {
                const bulletPoints = JSON.parse(summary.bullet_json);
                if (bulletPoints.length > 0) {
                    markdown += `### Key Points\n\n`;
                    bulletPoints.forEach((point: string) => {
                        markdown += `- ${point}\n`;
                    });
                    markdown += `\n`;
                }
            } catch (e) {
                console.error('Failed to parse bullet points:', e);
            }
        }
        
        if (summary.action_json) {
            try {
                const actionItems = JSON.parse(summary.action_json);
                if (actionItems.length > 0) {
                    markdown += `### Action Items\n\n`;
                    actionItems.forEach((action: string) => {
                        markdown += `- [ ] ${action}\n`;
                    });
                    markdown += `\n`;
                }
            } catch (e) {
                console.error('Failed to parse action items:', e);
            }
        }
    }
    
    // Add transcript for listen sessions
    if (transcripts && transcripts.length > 0) {
        markdown += `## Transcript\n\n`;
        transcripts.forEach((transcript) => {
            const speaker = transcript.speaker || 'Unknown';
            const time = transcript.start_at ? new Date(transcript.start_at * 1000).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            }) : '';
            markdown += `**${speaker}** ${time ? `(${time})` : ''}\n`;
            markdown += `${transcript.text}\n\n`;
        });
    }
    
    // Add Q&A for ask sessions
    if (ai_messages && ai_messages.length > 0) {
        markdown += `## Q&A\n\n`;
        ai_messages.forEach((message) => {
            const role = message.role === 'user' ? 'You' : 'AI';
            const time = message.sent_at ? new Date(message.sent_at * 1000).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit'
            }) : '';
            markdown += `### ${role} ${time ? `(${time})` : ''}\n\n`;
            markdown += `${message.content}\n\n`;
            markdown += `---\n\n`;
        });
    }
    
    // Add footer
    markdown += `*Exported from PickleGlass on ${new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    })}*\n`;
    
    return markdown;
};

export const downloadMarkdownFile = (content: string, filename: string): void => {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
};

export const exportAndDownloadSession = (sessionDetails: SessionDetails): void => {
    const markdown = exportSessionToMarkdown(sessionDetails);
    
    // Generate filename
    const sanitizeFilename = (title: string): string => {
        return title
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .toLowerCase()
            .substring(0, 50);
    };
    
    const date = new Date(sessionDetails.session.started_at * 1000)
        .toISOString()
        .split('T')[0]; // YYYY-MM-DD format
    const sanitizedTitle = sanitizeFilename(sessionDetails.session.title);
    const filename = `${sanitizedTitle}-${date}.md`;
    
    downloadMarkdownFile(markdown, filename);
};
