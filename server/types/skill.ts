export interface SkillMetadata {
  author: string
  author_email: string
  tags?: string[]
  homepage?: string
}

export interface SkillConfig {
  id: string
  name: string
  description: string
  metadata: SkillMetadata
  content: string
  files: string[]
}
