function sanitizeEpgText(text) {
    if (!text) {
        return '';
    }

    return text
        .replace(/\p{Extended_Pictographic}/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function formatProgramLine(program) {
    if (!program) {
        return [];
    }

    const timeRange = program.stop ? `${program.start} - ${program.stop}` : program.start;
    const title = sanitizeEpgText(program.title);

    const formattedTitle = title ? `• ${title}` : '';

    return [timeRange, formattedTitle].filter(Boolean);
}

function buildEpgDescription({ currentProgram, upcomingPrograms = [], upcomingLimit = 3 }) {
    const lines = [];

    if (currentProgram) {
        lines.push('Now');
        lines.push(...formatProgramLine(currentProgram));
    }

    const upcoming = upcomingPrograms.filter(Boolean).slice(0, upcomingLimit);
    if (upcoming.length > 0) {
        if (lines.length > 0) {
            lines.push('');
        }
        lines.push('Next');
        upcoming.forEach((program, index) => {
            const programLines = formatProgramLine(program);
            if (programLines.length > 0) {
                lines.push(...programLines);
                if (index < upcoming.length - 1) {
                    lines.push('');
                }
            }
        });
    }

    return lines.join('\n').trim();
}

module.exports = {
    buildEpgDescription
};
