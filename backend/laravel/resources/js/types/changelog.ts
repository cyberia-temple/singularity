export type ChangelogProductTrack = {
    id: string;
    name: string;
    version: string;
    status: string;
    description: string;
};

export type ChangelogDevelopmentItem = {
    date: string;
    title: string;
    description: string;
    commit: string;
};

export type ChangelogDevelopmentGroup = {
    id: string;
    name: string;
    items: ChangelogDevelopmentItem[];
};

export type ChangelogSection = {
    label: string;
    items: string[];
};

export type ChangelogRelease = {
    version: string;
    date: string;
    title: string;
    sections: ChangelogSection[];
};

export type AppRelease = {
    current: {
        version: string;
    };
    recent: ChangelogRelease[];
    changelogUrl: string;
};
